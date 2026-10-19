// eRIGHT sign-in — ESP32-S3 door reader / presence scanner.
// Reads an NFC card UID from a PN532 and POSTs it to /api/sign; a held button starts a fire roll call; the built-in
// RGB LED shows state. v3.5: also scans BLE for staff key tags (iBeacon or fixed-address beacons) and POSTs batched
// sightings to /api/presence/ble every BLE_POST_MS — the same firmware runs as a door scanner or an inside anchor,
// only SCANNER_NAME / SCANNER_ROLE differ (config.h). First compiled + flashed 2026-09-25; cards read 2026-09-27.
// v4.1: every HTTP call (taps, fire start, BLE batches, health check, heartbeat) runs in one network task on core 0.
// loop() only reads the button and the PN532 and drives the LED, so a slow or dead server can never make the fire
// button or the reader unresponsive. Shared state (tap queue, fire request, LED flash) is guarded by netLock; no HTTP
// call is ever made while holding it. POST /api/heartbeat every HEARTBEAT_MS lets the server notice a silent reader.
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

// Fire button: a press is a promise to start a roll call. If Wi-Fi or the server is down it is retried every
// FIRE_RETRY_MS until a 2xx, for up to FIRE_GIVE_UP_MS, with the LED blinking red so nobody walks away thinking it worked.
#define FIRE_RETRY_MS 3000
#define FIRE_GIVE_UP_MS (15UL * 60UL * 1000UL)
static bool firePending = false;
static unsigned long fireRequestedAt = 0;
static unsigned long lastFireAttempt = 0;

// Card taps that could not be delivered (no Wi-Fi / server down / 5xx) wait here and are replayed in order with
// "ageMs" so the server records when the tap really happened. eventKey makes replays idempotent. The queue is
// mirrored into NVS (Preferences) so a power cut does not lose a tap; ages are measured from boot after a restore,
// which under-states them (the server caps ageMs at 12 h anyway) — honest enough, and better than losing the tap.
struct PendingTap
{
    String uid;
    uint32_t key;
    unsigned long at;
    bool restored; // came back from flash after a reboot: its real time is unknown, so the server must not toggle on it
    bool tried;    // the network task has attempted it at least once (first attempt is immediate, retries every 5 s)
};
#define TAP_QUEUE_LEN 16
static PendingTap tapQueue[TAP_QUEUE_LEN];
static int tapHead = 0, tapCount = 0;
static unsigned long lastTapRetry = 0;
static unsigned long fireLedUntil = 0;   // non-blocking "roll call confirmed" red

#ifndef HEARTBEAT_MS
#define HEARTBEAT_MS (5UL * 60UL * 1000UL)
#endif
static unsigned long lastHeartbeat = 0;
// Guards tapQueue/tapHead/tapCount, firePending/fireRequestedAt/lastFireAttempt, fireLedUntil and the LED flash.
static SemaphoreHandle_t netLock = nullptr;
#define LOCK() xSemaphoreTake(netLock, portMAX_DELAY)
#define UNLOCK() xSemaphoreGive(netLock)

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
// A short result colour set by the network task (green delivered, orange refused/not delivered); loop() shows it.
static Led flashColour = LED_OFF;
static unsigned long flashUntil = 0;
void flash(Led c, unsigned long ms)
{
    LOCK();
    flashColour = c;
    flashUntil = millis() + ms;
    UNLOCK();
}

void ensureWifi()
{
    if (WiFi.status() == WL_CONNECTED)
        return;
    if (millis() - lastWifiAttempt < 10000)
        return;
    lastWifiAttempt = millis();
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

// POST one tap. Returns the HTTP status (-1 = not sent).
int sendTap(const PendingTap &t)
{
    // A restored tap has no trustworthy age: it is sent flagged so the server records that the card WAS tapped
    // while the reader was cut off, without guessing whether that meant in or out against today's register.
    String body = "{\"cardUid\":\"" + t.uid + "\",\"source\":\"esp32\",\"device\":\"" DEVICE_NAME "\",\"eventKey\":\"" DEVICE_NAME "-" + String(t.key) + "\",\"ageMs\":" + String(t.restored ? 12UL * 3600UL * 1000UL : millis() - t.at) + (t.restored ? ",\"restored\":true" : "") + "}";
    return postJson("/api/sign", body);
}
// Worth retrying: never sent, or the server failed. A 4xx (unknown card, bad token) will not improve with time.
bool retryable(int status) { return status <= 0 || status >= 500; }

// NVS mirror of the queue: "q" = "uid:key,uid:key,..." (16 entries max, well under the 4000-byte Preferences limit).
void saveQueue()
{
    String s;
    for (int i = 0; i < tapCount; i++)
    {
        const PendingTap &t = tapQueue[(tapHead + i) % TAP_QUEUE_LEN];
        s += (i ? "," : "") + t.uid + ":" + String(t.key);
    }
    prefs.putString("q", s);
}
void loadQueue()
{
    String s = prefs.getString("q", "");
    tapHead = tapCount = 0;
    int start = 0;
    while (start < (int)s.length() && tapCount < TAP_QUEUE_LEN)
    {
        int comma = s.indexOf(',', start);
        if (comma < 0)
            comma = s.length();
        String item = s.substring(start, comma);
        int colon = item.indexOf(':');
        if (colon > 0)
        {
            tapQueue[tapCount].uid = item.substring(0, colon);
            tapQueue[tapCount].key = item.substring(colon + 1).toInt();
            tapQueue[tapCount].at = millis();
            tapQueue[tapCount].restored = true;
            tapQueue[tapCount].tried = true; // nobody is standing at the door for these: no LED flash
            tapCount++;
        }
        start = comma + 1;
    }
    if (tapCount)
        LOG("[tap] %d tap(s) restored from flash, will be sent when the server answers\n", tapCount);
}

// Caller holds netLock.
void queueTap(const PendingTap &t)
{
    if (tapCount == TAP_QUEUE_LEN)
    { // full: drop the oldest, the newest taps matter most for "who is inside now"
        tapHead = (tapHead + 1) % TAP_QUEUE_LEN;
        tapCount--;
    }
    tapQueue[(tapHead + tapCount) % TAP_QUEUE_LEN] = t;
    tapCount++;
    saveQueue();
    LOG("[tap] queued %s (%d waiting)\n", t.uid.c_str(), tapCount);
}

// Network task: send the oldest waiting tap. A new tap is tried at once; a failed one every 5 s. The tap is copied out
// under the lock and sent without it; it is removed afterwards only if it is still the head (the queue may have
// dropped it meanwhile when full).
void drainTapQueue()
{
    while (true)
    {
        LOCK();
        if (!tapCount)
        {
            UNLOCK();
            return;
        }
        PendingTap head = tapQueue[tapHead];
        bool due = !head.tried || millis() - lastTapRetry >= 5000;
        UNLOCK();
        if (!due)
            return;
        int status = sendTap(head);
        LOCK();
        lastTapRetry = millis();
        bool stillHead = tapCount && tapQueue[tapHead].key == head.key;
        if (stillHead && !retryable(status))
        {
            tapHead = (tapHead + 1) % TAP_QUEUE_LEN;
            tapCount--;
            saveQueue();
        }
        else if (stillHead)
            tapQueue[tapHead].tried = true;
        UNLOCK();
        if (!head.tried) // feedback for the person at the door, once per tap
            flash(status == 200 ? LED_OK : LED_FAIL, status == 200 ? 600 : 1200);
        if (retryable(status))
            return;
    }
}

void handleCard(const String &uid)
{
    if (uid == lastUid && millis() - lastUidAt < CARD_DEBOUNCE_MS)
        return;
    lastUid = uid;
    lastUidAt = millis();
    eventCounter++;
    prefs.putUInt("counter", eventCounter);
    PendingTap t = {uid, eventCounter, millis(), false, false};
    // Every tap goes through the queue (order kept, mirrored to flash); the network task sends it straight away and
    // flashes green when the server took it, orange when it did not. If older taps are still waiting, this one cannot
    // be sent first: say so NOW (orange) so the person does not tap again (a second tap would toggle them back out),
    // and never flash for it later when nobody is standing there.
    LOCK();
    bool behind = tapCount > 0;
    if (behind)
        t.tried = true;
    queueTap(t);
    UNLOCK();
    if (behind)
        flash(LED_FAIL, 1200);
}

void handleFireButton()
{
    bool down = digitalRead(PIN_FIRE_BUTTON) == LOW;
    if (down && !buttonWasDown)
        buttonDownAt = millis();
    if (down && millis() - buttonDownAt >= FIRE_HOLD_MS && buttonWasDown)
    {
        LOCK();
        if (!firePending)
            LOG("[fire] button held: starting a roll call\n");
        firePending = true;
        fireRequestedAt = millis();
        lastFireAttempt = 0;
        UNLOCK();
        buttonDownAt = millis() + 60000; // one press = one roll call; ignore the rest of this hold
    }
    buttonWasDown = down;
}

// Network task.
void serviceFire()
{
    LOCK();
    bool go = firePending && !(lastFireAttempt && millis() - lastFireAttempt < FIRE_RETRY_MS);
    if (go && millis() - fireRequestedAt > FIRE_GIVE_UP_MS)
    {
        LOG("[fire] gave up after %lu min without reaching the server\n", FIRE_GIVE_UP_MS / 60000);
        firePending = false;
        go = false;
    }
    if (go)
        lastFireAttempt = millis();
    UNLOCK();
    if (!go)
        return;
    int status = postJson("/api/fire/start", "{\"source\":\"esp32\",\"by\":\"door button\",\"device\":\"" DEVICE_NAME "\"}");
    if (status >= 200 && status < 300)
    {
        LOCK();
        firePending = false;
        fireLedUntil = millis() + 3000; // steadyLed shows solid red until then
        UNLOCK();
    }
}

// Network task: "I am alive" every HEARTBEAT_MS. Any valid device token is accepted (route auth device:any).
void serviceHeartbeat()
{
    if (WiFi.status() != WL_CONNECTED || (lastHeartbeat && millis() - lastHeartbeat < HEARTBEAT_MS))
        return;
    lastHeartbeat = millis();
    postJson("/api/heartbeat", "{\"device\":\"" DEVICE_NAME "\"}");
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
// onResult runs on the NimBLE host task, blePost on loop(): the buffer is shared, so guard it. The callback never
// waits for the lock (a dropped frame is re-heard within a second); loop() takes it just long enough to copy out.
static SemaphoreHandle_t seenLock = nullptr;

void noteTag(const String &tag, int rssi)
{
    if (!seenLock || xSemaphoreTake(seenLock, 0) != pdTRUE)
        return;
    for (int i = 0; i < seenN; i++)
        if (seen[i].tag == tag)
        {
            if (rssi > seen[i].rssi)
                seen[i].rssi = rssi;
            xSemaphoreGive(seenLock);
            return;
        }
    if (seenN < (int)(sizeof(seen) / sizeof(seen[0])))
    {
        seen[seenN].tag = tag;
        seen[seenN].rssi = rssi;
        seenN++;
    }
    xSemaphoreGive(seenLock);
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
    seenLock = xSemaphoreCreateMutex();
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
    xSemaphoreTake(seenLock, portMAX_DELAY);
    int n = seenN;
    String body = "{\"scanner\":\"" SCANNER_NAME "\",\"sightings\":[";
    for (int i = 0; i < n; i++)
        body += String(i ? "," : "") + "{\"tag\":\"" + seen[i].tag + "\",\"rssi\":" + seen[i].rssi + "}";
    body += "]}";
    seenN = 0;
    xSemaphoreGive(seenLock);
    if (n == 0 || WiFi.status() != WL_CONNECTED)
        return;
    int status = postJson("/api/presence/ble", body);
    if (status == 200)
    {
        bleBatches++;
        bleTags += n;
    }
}
#endif

// The only place that talks to the network.
void netTask(void *)
{
    for (;;)
    {
        ensureWifi();
        if (WiFi.status() == WL_CONNECTED && !serverChecked)
            checkServer();
        if (WiFi.status() != WL_CONNECTED)
            serverChecked = false;
        serviceFire(); // first: a roll call matters more than a queued tap
        drainTapQueue();
#if BLE_SCAN
        blePost();
#endif
        serviceHeartbeat();
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

void setup()
{
    Serial.begin(115200);
    Serial0.begin(115200); // UART0 = the CH343 bench lead; Serial = native USB CDC
    delay(300);
    LOG("\n[boot] eRIGHT %s '%s' -> %s\n", SCANNER_ROLE, DEVICE_NAME, SERVER_URL);
    pinMode(PIN_FIRE_BUTTON, INPUT_PULLUP);
    prefs.begin("door", false);
    eventCounter = prefs.getUInt("counter", 0);
    netLock = xSemaphoreCreateMutex();
    loadQueue();

    if (HAS_PN532)
    {
        Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
        probeNfc();
    }
#if BLE_SCAN
    bleBegin();
#endif
    // Core 0 (where Wi-Fi runs); loop() stays on core 1. 8 KB stack: HTTPClient + String bodies.
    xTaskCreatePinnedToCore(netTask, "net", 8192, nullptr, 1, nullptr, 0);
}

// Resting colour, re-asserted every loop so the guide's LED table stays true: purple no Wi-Fi, orange no PN532, dim blue ready.
// A roll-call press that has not reached the server yet overrides everything: red blinking twice a second.
void steadyLed()
{
    LOCK();
    bool pending = firePending;
    unsigned long fireUntil = fireLedUntil, until = flashUntil;
    Led colour = flashColour;
    UNLOCK();
    if (pending)
        led((millis() / 250) % 2 ? LED_FIRE : LED_OFF);
    else if (millis() < fireUntil)
        led(LED_FIRE);
    else if (millis() < until)
        led(colour);
    else if (WiFi.status() != WL_CONNECTED)
        led(LED_NOWIFI);
    else if (HAS_PN532 && !nfcReady)
        led(LED_FAIL);
    else
        led(LED_IDLE);
}

void loop()
{
    handleFireButton();
    steadyLed();

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
