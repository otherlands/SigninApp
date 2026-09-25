// Copy to config.h and fill in. config.h is git-ignored.
#pragma once

#define WIFI_SSID "your-ssid"
#define WIFI_PASSWORD "your-password"

// Main sign-in server (not the mirror). No trailing slash.
#define SERVER_URL "http://192.168.1.10:3000"
// Must match API_TOKEN on the server.
#define API_TOKEN "change-me"
// Appears in the event log as the device column.
#define DEVICE_NAME "front-door-reader"

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
