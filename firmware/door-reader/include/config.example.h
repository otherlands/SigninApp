// Copy to config.h and fill in. config.h is git-ignored.
#pragma once

#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"

// Main sign-in server (not the mirror). No trailing slash.
#define SERVER_URL "http://192.168.1.10:3000"
// Must match API_TOKEN on the server.
#define API_TOKEN "change-me"
// Appears in the event log as the device column.
#define DEVICE_NAME "back-door-reader"

// v3.5 presence scanner. SCANNER_NAME must match a name in the server's DOOR_SCANNERS or ANCHOR_SCANNERS list
// (defaults: front-door,back-door / anchor). Roles: "door" (has PN532 + button) or "anchor" (inside, BLE only).
#define SCANNER_NAME "back-door"
#define SCANNER_ROLE "door"
// v4.1: OFF by default. Presence is off on the server unless PRESENCE=on; the plain card reader needs no BLE.
#define BLE_SCAN 0 // 1 to also scan for BLE key tags (and set PRESENCE=on on the server)
#define BLE_POST_MS 5000
#define HAS_PN532 1 // 0 for an anchor board with no reader wired

// PN532 over I2C. Check your board's silkscreen; these are typical ESP32-S3 DevKitC pins.
#define PIN_I2C_SDA 8
#define PIN_I2C_SCL 9
#define PIN_PN532_IRQ -1 // not used in polling mode
#define PIN_PN532_RESET -1

// Momentary button to GND that starts a fire roll call (held for FIRE_HOLD_MS).
#define PIN_FIRE_BUTTON 4
#define FIRE_HOLD_MS 1500

// Same card presented again within this window is ignored (reader chatter).
#define CARD_DEBOUNCE_MS 2500

// v4.1: "I am alive" to POST /api/heartbeat. The server's EXPECT_DEVICES check reports a reader silent for
// DEVICE_SILENT_MINUTES (default 15). Optional: defaults to 5 minutes if not defined here.
#define HEARTBEAT_MS (5UL * 60UL * 1000UL)
