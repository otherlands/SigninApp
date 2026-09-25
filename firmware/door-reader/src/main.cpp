// eRIGHT sign-in v3 — optional ESP32-S3 door reader.
// Reads an NFC card UID from a PN532 and POSTs it to /api/sign on the main server.
// A held button starts a fire roll call. Built-in RGB LED shows state.
// NOT COMPILED HERE: build and bench-test with PlatformIO before fitting it to a door.
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <Preferences.h>
#include <Adafruit_PN532.h>
#include "config.h"

Adafruit_PN532 nfc(PIN_PN532_IRQ, PIN_PN532_RESET, &Wire);
Preferences prefs;

static uint32_t eventCounter = 0;
static String lastUid;
static unsigned long lastUidAt = 0;
static unsigned long buttonDownAt = 0;
static bool buttonWasDown = false;
static unsigned long lastWifiAttempt = 0;

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
    Serial.printf("[wifi] connecting to %s\n", WIFI_SSID);
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
        Serial.printf("[http] %s -> %d %s\n", path, status, http.getString().c_str());
    else
        Serial.printf("[http] %s failed: %s\n", path, http.errorToString(status).c_str());
    http.end();
    return status;
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

void setup()
{
    Serial.begin(115200);
    delay(300);
    pinMode(PIN_FIRE_BUTTON, INPUT_PULLUP);
    prefs.begin("door", false);
    eventCounter = prefs.getUInt("counter", 0);

    Wire.begin(PIN_I2C_SDA, PIN_I2C_SCL);
    nfc.begin();
    uint32_t version = nfc.getFirmwareVersion();
    if (!version)
    {
        Serial.println("[nfc] PN532 not found on I2C — check wiring and the board's DIP switches (I2C mode)");
        led(LED_FAIL);
    }
    else
    {
        Serial.printf("[nfc] PN5%02X firmware %d.%d\n", (version >> 24) & 0xFF, (version >> 16) & 0xFF, (version >> 8) & 0xFF);
        nfc.SAMConfig();
    }
    ensureWifi();
    led(LED_IDLE);
}

void loop()
{
    ensureWifi();
    handleFireButton();

    uint8_t uid[7] = {0};
    uint8_t uidLength = 0;
    // 200 ms timeout keeps the button responsive between reads.
    if (nfc.readPassiveTargetID(PN532_MIFARE_ISO14443A, uid, &uidLength, 200))
    {
        handleCard(uidToHex(uid, uidLength));
    }
}
