// eRIGHT sign-in — ESP32-S3 door reader / presence scanner.
// Reads an NFC card UID from a PN532 and POSTs it to /api/sign; a held button starts a fire roll call; the built-in
// RGB LED shows state. v3.5: also scans BLE for staff key tags (iBeacon or fixed-address beacons) and POSTs batched
// sightings to /api/presence/ble every BLE_POST_MS — the same firmware runs as a door scanner or an inside anchor,
// only SCANNER_NAME / SCANNER_ROLE differ (config.h). First compiled + flashed 2026-09-25; cards read 2026-09-27.
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Preferences.h>
#include <Adafruit_PN532.h>
#include "config.h"
#if BLE_SCAN
#include <NimBLEDevice.h>
#endif

// Log to both the native-USB CDC port and UART0 so a bench UART lead sees everything
#define LOG(...)                     \
    do                               \
    {                                \
        Serial.printf(__VA_ARGS__);  \
        Serial0.printf(__VA_ARGS__); \
    } while (0)

Adafruit_PN532 nfc(PIN_PN532_IRQ, PIN_PN532_RESET, &Wire);
Preferences prefs;

static uint32_t eventCounter = 0;
static String lastUid;
static unsigned long lastUidAt = 0;
static unsigned long buttonDownAt = 0;
static bool buttonWasDown = false;
static unsigned long lastWifiAttempt = 0;
static bool nfcReady = false;
static unsigned long lastNfcProbe = 0;
static unsigned long lastStatus = 0;
static bool serverChecked = false;

enum Led
{
    LED_OFF,
    LED_IDLE,
    LED_OK,
    LED_FAIL,
    LED_FIRE,
    LED_NOWIFI
};
void led(Led s)
{
#ifdef RGB_BUILTIN
    switch (s)
    {
    case LED_IDLE:
        neopixelWrite(RGB_BUILTIN, 0, 0, 8);
        break;
    case LED_OK:
        neopixelWrite(RGB_BUILTIN, 0, 40, 0);
        break;
    case LED_FAIL:
        neopixelWrite(RGB_BUILTIN, 40, 20, 0);
        break;
    case LED_FIRE:
        neopixelWrite(RGB_BUILTIN, 60, 0, 0);
        break;
    case LED_NOWIFI:
        neopixelWrite(RGB_BUILTIN, 12, 0, 12);
        break;
    default:
        neopixelWrite(RGB_BUILTIN, 0, 0, 0);
    }
#endif
}

void ensureWifi()
{
    if (WiFi.status() == WL_CONNECTED)
        return;
    if (millis() - lastWifiAttempt < 10000)
        return;
    lastWifiAttempt = millis();
    led(LED_NOWIFI);
    LOG("[wifi] connecting to %s\n", WIFI_SSID);
    WiFi.mode(WIFI_STA);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// Returns HTTP status, or -1 when the request could not be sent.
int postJson(const char *path, const String &body)
{
    if (WiFi.status() != WL_CONNECTED)
        return -1;
    HTTPClient http;
    http.setTimeout(4000);
    http.begin(String(SERVER_URL) + path);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("X-Api-Token", API_TOKEN);
    http.addHeader("X-Device", DEVICE_NAME);
    int status = http.POST(body);
    if (status > 0)
        LOG("[http] %s -> %d %s\n", path, status, http.getString().c_str());
    else
        LOG("[http] %s failed: %s\n", path, http.errorToString(status).c_str());
    http.end();
    return status;
}

// One GET /api/health after Wi-Fi comes up: proves the route to the sign-in server before any card is read.
void checkServer()
{
    HTTPClient http;
    http.setTimeout(4000);
    http.begin(String(SERVER_URL) + "/api/health");
    int status = http.GET();
    if (status > 0)
        LOG("[server] %s/api/health -> %d %s\n", SERVER_URL, status, http.getString().substring(0, 120).c_str());
    else
        LOG("[server] %s unreachable: %s\n", SERVER_URL, http.errorToString(status).c_str());
    http.end();
    serverChecked = true;
}

// PN532 is optional at bench time: probe quietly, retry every 30 s, never poll an absent chip (it floods the log).
// On a miss, scan the bus: a PN532 in I2C mode answers at 0x24; anything else found tells us the wiring is fine
// and the DIP switches are not; nothing found means SDA/SCL/GND are not reaching the chip.
void scanI2c()
{
    int found = 0;
    String seen;
    for (uint8_t a = 1; a < 127; a++)
    {
        Wire.beginTransmission(a);
        if (Wire.endTransmission() == 0)
        {
            found++;
            seen += " 0x" + String(a, HEX);
        }
    }
    if (found)
        LOG("[i2c] %d device(s) on SDA %d / SCL %d:%s  (PN532 in I2C mode = 0x24)\n", found, PIN_I2C_SDA, PIN_I2C_SCL, seen.c_str());
    else
        LOG("[i2c] bus empty on SDA %d / SCL %d - no device acknowledges any address (check SDA/SCL wires and GND)\n", PIN_I2C_SDA, PIN_I2C_SCL);
}

void probeNfc()
{
    lastNfcProbe = millis();
    nfc.begin();
    uint32_t version = nfc.getFirmwareVersion();
    if (!version)
    {
        scanI2c();
        if (!nfcReady)
            LOG("[nfc] PN532 not found on I2C (SDA %d SCL %d) - button still works; retrying every 30 s\n", PIN_I2C_SDA, PIN_I2C_SCL);
        nfcReady = false;
        return;
    }
    LOG("[nfc] PN5%02X firmware %d.%d ready\n", (version >> 24) & 0xFF, (version >> 16) & 0xFF, (version >> 8) & 0xFF);
    nfc.SAMConfig();
    nfcReady = true;
}

String uidToHex(const uint8_t *uid, uint8_t len)
{
    String s;
    for (uint8_t i = 0; i < len; i++)
    {
        if (uid[i] < 0x10)
            s += '0';
        s += String(uid[i], HEX);
    }
    s.toUpperCase();
    return s;
}

void handleCard(const String &uid)
{
    if (uid == lastUid && millis() - lastUidAt < CARD_DEBOUNCE_MS)
        return;
    lastUid = uid;
    lastUidAt = millis();
    eventCounter++;
    prefs.putUInt("counter", eventCounter);
    // eventKey lets the server ignore a retry of the same tap (see /api/sign idempotency).
    String body = "{\"cardUid\":\"" + uid + "\",\"source\":\"esp32\",\"device\":\"" DEVICE_NAME "\",\"eventKey\":\"" DEVICE_NAME "-" + String(eventCounter) + "\"}";
    int status = postJson("/api/sign", body);
    led(status == 200 ? LED_OK : LED_FAIL);
    delay(status == 200 ? 600 : 1200);
    led(LED_IDLE);
}

void handleFireButton()
{
    bool down = digitalRead(PIN_FIRE_BUTTON) == LOW;
    if (down && !buttonWasDown)
        buttonDownAt = millis();
    if (down && millis() - buttonDownAt >= FIRE_HOLD_MS && buttonWasDown)
    {
        led(LED_FIRE);
        postJson("/api/fire/start", "{\"source\":\"esp32\",\"by\":\"door button\",\"device\":\"" DEVICE_NAME "\"}");
        delay(3000);
        led(LED_IDLE);
        buttonDownAt = millis() + 60000; // one press = one roll call; ignore the rest of this hold
    }
    buttonWasDown = down;
}

#if BLE_SCAN
// ---- BLE presence scanner -------------------------------------------------------------------------------------
// Tag identity: iBeacon frames (Apple 0x004C, type 0x02 len 0x15) -> "ibeacon:<uuid>:<major>:<minor>"; any other
// advertiser with a PUBLIC (fixed) address -> "mac:AA:BB:...". Random addresses (phones) are ignored: they are not
// identities. Per window we keep the strongest RSSI per tag and post the batch once.
struct Seen
{
    String tag;
    int rssi;
};
static Seen seen[24];
static int seenN = 0;
static unsigned long lastBlePost = 0;
static uint32_t bleBatches = 0, bleTags = 0;

void noteTag(const String &tag, int rssi)
{
    for (int i = 0; i < seenN; i++)
        if (seen[i].tag == tag)
        {
            if (rssi > seen[i].rssi)
                seen[i].rssi = rssi;
            return;
        }
    if (seenN < (int)(sizeof(seen) / sizeof(seen[0])))
    {
        seen[seenN].tag = tag;
        seen[seenN].rssi = rssi;
        seenN++;
    }
}

class ScanCb : public NimBLEScanCallbacks
{
    void onResult(const NimBLEAdvertisedDevice *d) override
    {
        std::string md = d->getManufacturerData();
        if (md.size() >= 25 && (uint8_t)md[0] == 0x4C && (uint8_t)md[1] == 0x00 && (uint8_t)md[2] == 0x02 && (uint8_t)md[3] == 0x15)
        {
            char uuid[37];
            const uint8_t *u = (const uint8_t *)md.data() + 4;
            snprintf(uuid, sizeof uuid, "%02X%02X%02X%02X-%02X%02X-%02X%02X-%02X%02X-%02X%02X%02X%02X%02X%02X",
                     u[0], u[1], u[2], u[3], u[4], u[5], u[6], u[7], u[8], u[9], u[10], u[11], u[12], u[13], u[14], u[15]);
            uint16_t major = ((uint8_t)md[20] << 8) | (uint8_t)md[21], minor = ((uint8_t)md[22] << 8) | (uint8_t)md[23];
            noteTag(String("ibeacon:") + uuid + ":" + major + ":" + minor, d->getRSSI());
            return;
        }
        if (d->getAddress().getType() == BLE_ADDR_PUBLIC)
        {
            String mac = d->getAddress().toString().c_str();
            mac.toUpperCase();
            noteTag("mac:" + mac, d->getRSSI());
        }
    }
};
static ScanCb scanCb;

void bleBegin()
{
    NimBLEDevice::init("");
    NimBLEScan *s = NimBLEDevice::getScan();
    s->setScanCallbacks(&scanCb, false);
    s->setActiveScan(false); // passive: beacons broadcast, no scan-request traffic
    s->setInterval(100);
    s->setWindow(60);             // 60 % duty leaves Wi-Fi its share of the shared radio
    s->setDuplicateFilter(false); // we want every frame so RSSI max is fresh
    s->start(0, false, true);     // continuous
    LOG("[ble] scanner '%s' role=%s scanning\n", SCANNER_NAME, SCANNER_ROLE);
}

void blePost()
{
    if (millis() - lastBlePost < BLE_POST_MS)
        return;
    lastBlePost = millis();
    if (seenN == 0 || WiFi.status() != WL_CONNECTED)
    {
        seenN = 0;
        return;
    }
    String body = "{\"scanner\":\"" SCANNER_NAME "\",\"sightings\":[";
    for (int i = 0; i < seenN; i++)
        body += String(i ? "," : "") + "{\"tag\":\"" + seen[i].tag + "\",\"rssi\":" + seen[i].rssi + "}";
    body += "]}";
    int n = seenN;
    seenN = 0;
    int status = postJson("/api/presence/ble", body);
    if (status == 200)
    {
        bleBatches++;
        bleTags += n;
    }
}
#endif

void setup()
{
    Serial.begin(115200);
    Serial0.begin(115200); // UART0 = the CH343 bench lead; Serial = native USB CDC
    delay(300);
    LOG("\n[boot] eRIGHT %s '%s' -> %s\n", SCANNER_ROLE, DEVICE_NAME, SERVER_URL);
    pinMode(PIN_FIRE_BUTTON, INPUT_PULLUP);
    prefs.begin("door", false);
    eventCounter = prefs.getUInt("counter", 0);

    if (HAS_PN532)
    {
        Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
        probeNfc();
    }
    ensureWifi();
#if BLE_SCAN
    bleBegin();
#endif
}

// Resting colour, re-asserted every loop so the guide's LED table stays true: purple no Wi-Fi, orange no PN532, dim blue ready.
void steadyLed()
{
    if (WiFi.status() != WL_CONNECTED)
        led(LED_NOWIFI);
    else if (HAS_PN532 && !nfcReady)
        led(LED_FAIL);
    else
        led(LED_IDLE);
}

void loop()
{
    ensureWifi();
    handleFireButton();
    steadyLed();

    if (WiFi.status() == WL_CONNECTED && !serverChecked)
        checkServer();
    if (WiFi.status() != WL_CONNECTED)
        serverChecked = false;
#if BLE_SCAN
    blePost();
#endif

    if (millis() - lastStatus >= 30000)
    {
        lastStatus = millis();
#if BLE_SCAN
        LOG("[status] up %lus wifi=%s ip=%s rssi=%d nfc=%s events=%u ble_batches=%u ble_tags=%u\n", millis() / 1000,
            WiFi.status() == WL_CONNECTED ? "up" : "down", WiFi.localIP().toString().c_str(), WiFi.RSSI(),
            HAS_PN532 ? (nfcReady ? "ready" : "absent") : "n/a", eventCounter, bleBatches, bleTags);
#else
        LOG("[status] up %lus wifi=%s ip=%s rssi=%d nfc=%s events=%u\n", millis() / 1000,
            WiFi.status() == WL_CONNECTED ? "up" : "down", WiFi.localIP().toString().c_str(), WiFi.RSSI(),
            HAS_PN532 ? (nfcReady ? "ready" : "absent") : "n/a", eventCounter);
#endif
    }

    if (!HAS_PN532)
    {
        delay(20);
        return;
    }
    if (!nfcReady)
    {
        if (millis() - lastNfcProbe >= 30000)
            probeNfc();
        delay(20);
        return;
    }

    uint8_t uid[7] = {0};
    uint8_t uidLength = 0;
    // 200 ms timeout keeps the button responsive between reads.
    if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 200))
    {
        handleCard(uidToHex(uid, uidLength));
    }
}
