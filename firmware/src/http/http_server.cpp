// HttpServer implementation. See http_server.h for the design notes.
//
// Layered exactly like wifi_manager.cpp:
//
//   1. Always-on pure helpers (parseMethod / routeMatches / parseRequestLine /
//      parseWifiJson). Plain C++ that compiles under both the Arduino target
//      and `platform = native`; exercised by the host Catch2 suite.
//
//   2. The HttpServer methods. The class always constructs (so it links into
//      the host test binary), but the real socket handling is compiled only
//      under `#if defined(ARDUINO)`.
//
//   3. Real WiFiS3 socket + ArduinoJson code, behind `#if defined(ARDUINO)`.

#include "http_server.h"

#include <cstring>

#if defined(ARDUINO)
#  include <Arduino.h>
#  include <WiFi.h>          // WiFiS3: WiFiServer / WiFiClient on UNO R4 WiFi
#  include <ArduinoJson.h>   // bblanchon/ArduinoJson (platformio.ini dep)

// ---------------------------------------------------------------------------
// Web-asset blob (Design §2.4.4, §10.3).
//
// Task 29.2's embed_web_assets.py generates firmware/src/web_assets.h with:
//   static const uint8_t WEB_INDEX_GZ[] PROGMEM = { ... };
//   static const size_t  WEB_INDEX_GZ_LEN = <n>;
// Until that script runs the header is absent, so we guard the include and
// fall back to a tiny inline "booting" page. This keeps the firmware linkable
// before task 29.2 and makes the dependency explicit.
#  if __has_include("web_assets.h")
#    include "web_assets.h"
#    define ETCH_HAS_WEB_ASSETS 1
#  else
#    define ETCH_HAS_WEB_ASSETS 0
#  endif
#endif  // ARDUINO

namespace etch {
namespace http {

// ===========================================================================
// 1. Pure helpers (host-testable, Arduino-free)
// ===========================================================================

namespace {

// Bounded strlen so we never walk off a malformed, non-terminated buffer.
std::size_t boundedLen(const char* s, std::size_t cap) {
  std::size_t n = 0;
  while (n < cap && s[n] != '\0') ++n;
  return n;
}

// Decode a single hex digit, or -1 if not [0-9A-Fa-f].
int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  return -1;
}

// Append a Unicode code point (BMP) as UTF-8 to `out` at `*pos`, respecting
// the buffer capacity `cap` (which must leave room for the trailing NUL the
// caller writes). Returns false if there is not enough room.
bool appendUtf8(char* out, std::size_t cap, std::size_t& pos,
                std::uint32_t cp) {
  if (cp <= 0x7F) {
    if (pos + 1 > cap) return false;
    out[pos++] = static_cast<char>(cp);
  } else if (cp <= 0x7FF) {
    if (pos + 2 > cap) return false;
    out[pos++] = static_cast<char>(0xC0 | (cp >> 6));
    out[pos++] = static_cast<char>(0x80 | (cp & 0x3F));
  } else {
    if (pos + 3 > cap) return false;
    out[pos++] = static_cast<char>(0xE0 | (cp >> 12));
    out[pos++] = static_cast<char>(0x80 | ((cp >> 6) & 0x3F));
    out[pos++] = static_cast<char>(0x80 | (cp & 0x3F));
  }
  return true;
}

// A tiny hand-rolled scanner over the fixed-shape WiFi-credentials JSON. It is
// intentionally permissive about key ordering and surrounding whitespace, and
// strict about the two keys it cares about. State for one in-progress parse.
struct JsonScanner {
  const char* p;
  const char* end;

  bool atEnd() const { return p >= end; }
  char peek() const { return *p; }

  void skipWs() {
    while (p < end &&
           (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r')) {
      ++p;
    }
  }

  // Parse a JSON string starting at the opening quote. Writes the decoded,
  // NUL-terminated value into out[0..cap). On overflow the scanner still runs
  // to the closing quote so `p` is left just past the string (the caller can
  // continue parsing the rest of the object). Returns:
  //   1  -> success
  //   0  -> not a string here / malformed escape (treat as parse error)
  //  -1  -> value overflowed `cap` (caller maps to *TooLong); `out` is emptied
  int parseString(char* out, std::size_t cap, std::size_t& outLen) {
    if (p >= end || *p != '"') return 0;
    ++p;  // consume opening quote
    std::size_t pos = 0;
    bool overflow = false;

    // Append one decoded byte, flagging overflow once the value (plus its NUL)
    // no longer fits. We keep scanning either way so `p` ends past the string.
    auto put = [&](char ch) {
      if (!overflow && pos + 1 < cap) {
        out[pos++] = ch;
      } else {
        overflow = true;
      }
    };

    while (p < end) {
      char c = *p++;
      if (c == '"') {
        if (overflow) {
          if (cap > 0) out[0] = '\0';
          return -1;
        }
        out[pos] = '\0';
        outLen = pos;
        return 1;
      }
      if (c == '\\') {
        if (p >= end) return 0;
        char esc = *p++;
        switch (esc) {
          case '"':  put('"');  break;
          case '\\': put('\\'); break;
          case '/':  put('/');  break;
          case 'n':  put('\n'); break;
          case 'r':  put('\r'); break;
          case 't':  put('\t'); break;
          case 'b':  put('\b'); break;
          case 'f':  put('\f'); break;
          case 'u': {
            if (end - p < 4) return 0;
            int h0 = hexVal(p[0]), h1 = hexVal(p[1]);
            int h2 = hexVal(p[2]), h3 = hexVal(p[3]);
            if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) return 0;
            const std::uint32_t cp = static_cast<std::uint32_t>(
                (h0 << 12) | (h1 << 8) | (h2 << 4) | h3);
            p += 4;
            if (!overflow && !appendUtf8(out, cap - 1, pos, cp)) {
              overflow = true;
            }
            break;
          }
          default:
            return 0;  // unknown escape
        }
      } else {
        put(c);
      }
    }
    return 0;  // unterminated string
  }

  // Skip a JSON value we do not care about (string, number, bool, null,
  // object, or array). Returns false on malformed input.
  bool skipValue() {
    skipWs();
    if (p >= end) return false;
    char c = *p;
    if (c == '"') {
      // Skip a string with escape awareness.
      ++p;
      while (p < end) {
        char d = *p++;
        if (d == '\\') { if (p < end) ++p; }
        else if (d == '"') return true;
      }
      return false;
    }
    if (c == '{' || c == '[') {
      const char open = c;
      const char close = (c == '{') ? '}' : ']';
      int depth = 0;
      while (p < end) {
        char d = *p++;
        if (d == '"') {  // skip nested string
          while (p < end) {
            char e = *p++;
            if (e == '\\') { if (p < end) ++p; }
            else if (e == '"') break;
          }
        } else if (d == open) {
          ++depth;
        } else if (d == close) {
          if (--depth == 0) return true;
        }
      }
      return false;
    }
    // Primitive: run until a structural delimiter.
    while (p < end && *p != ',' && *p != '}' && *p != ']') ++p;
    return true;
  }
};

}  // namespace

HttpMethod parseMethod(const char* token) {
  if (token == nullptr) return HttpMethod::Unknown;
  if (std::strcmp(token, "GET") == 0) return HttpMethod::Get;
  if (std::strcmp(token, "POST") == 0) return HttpMethod::Post;
  return HttpMethod::Unknown;
}

bool routeMatches(const char* path, const char* pattern) {
  if (path == nullptr || pattern == nullptr) return false;

  const std::size_t plen = std::strlen(pattern);
  if (plen > 0 && pattern[plen - 1] == '*') {
    // Prefix match: every char before the '*' must be a prefix of `path`.
    const std::size_t prefixLen = plen - 1;
    return std::strncmp(path, pattern, prefixLen) == 0;
  }
  return std::strcmp(path, pattern) == 0;
}

bool parseRequestLine(const char* line, HttpMethod& methodOut, char* pathOut,
                      std::size_t pathCap) {
  methodOut = HttpMethod::Unknown;
  if (pathCap > 0) pathOut[0] = '\0';
  if (line == nullptr || pathCap == 0) return false;

  const std::size_t len = boundedLen(line, HTTP_REQUEST_LINE_MAX);

  // --- method token: up to the first space ---
  std::size_t i = 0;
  char method[8] = {0};
  std::size_t m = 0;
  while (i < len && line[i] != ' ') {
    if (m + 1 >= sizeof(method)) {  // method longer than any we know
      // Drain the rest of the token so the path scan starts cleanly, then
      // bail: an over-long method is by definition unrecognised.
      return false;
    }
    method[m++] = line[i++];
  }
  method[m] = '\0';
  if (i >= len || line[i] != ' ') return false;  // no target after method
  ++i;  // consume the space

  const HttpMethod parsed = parseMethod(method);
  if (parsed == HttpMethod::Unknown) return false;

  // --- request target: up to next space, '?', or end ---
  std::size_t out = 0;
  while (i < len && line[i] != ' ' && line[i] != '?') {
    if (out + 1 >= pathCap) {  // would overflow (need room for NUL)
      pathOut[0] = '\0';
      return false;
    }
    pathOut[out++] = line[i++];
  }
  pathOut[out] = '\0';

  if (out == 0) return false;  // empty target is malformed

  methodOut = parsed;
  return true;
}

WifiJsonResult parseWifiJson(const char* body, char* ssidOut,
                             std::size_t ssidCap, char* pwOut,
                             std::size_t pwCap) {
  if (ssidCap > 0) ssidOut[0] = '\0';
  if (pwCap > 0) pwOut[0] = '\0';
  if (body == nullptr || ssidCap == 0 || pwCap == 0) {
    return WifiJsonResult::Malformed;
  }

  const std::size_t len = boundedLen(body, HTTP_BODY_MAX);
  JsonScanner s{body, body + len};

  s.skipWs();
  if (s.atEnd() || s.peek() != '{') return WifiJsonResult::Malformed;
  ++s.p;  // consume '{'

  bool haveSsid = false;
  bool havePw = false;
  bool ssidOverflow = false;
  bool pwOverflow = false;

  s.skipWs();
  if (!s.atEnd() && s.peek() == '}') {
    // Empty object: both fields missing. Report ssid first for determinism.
    return WifiJsonResult::MissingSsid;
  }

  while (!s.atEnd()) {
    s.skipWs();
    // --- key ---
    char key[24] = {0};
    std::size_t keyLen = 0;
    const int kr = s.parseString(key, sizeof(key), keyLen);
    if (kr == 0) return WifiJsonResult::Malformed;
    // kr == -1 means an absurdly long key; it is not one we care about, so
    // treat it as an unknown key and skip its value below. Re-scan/skip it
    // safely by skipping the value after the colon.

    s.skipWs();
    if (s.atEnd() || s.peek() != ':') return WifiJsonResult::Malformed;
    ++s.p;  // consume ':'
    s.skipWs();

    const bool isSsid = (kr == 1) && std::strcmp(key, "ssid") == 0;
    const bool isPw = (kr == 1) && std::strcmp(key, "password") == 0;

    if (isSsid) {
      std::size_t n = 0;
      const int r = s.parseString(ssidOut, ssidCap, n);
      if (r == 0) return WifiJsonResult::Malformed;
      if (r == -1) ssidOverflow = true;  // out emptied, scanner past string
      haveSsid = true;
    } else if (isPw) {
      std::size_t n = 0;
      const int r = s.parseString(pwOut, pwCap, n);
      if (r == 0) return WifiJsonResult::Malformed;
      if (r == -1) pwOverflow = true;
      havePw = true;
    } else {
      if (!s.skipValue()) return WifiJsonResult::Malformed;
    }

    s.skipWs();
    if (s.atEnd()) break;
    if (s.peek() == ',') { ++s.p; continue; }
    if (s.peek() == '}') break;
    return WifiJsonResult::Malformed;
  }

  // Precedence: missing fields before oversize, ssid before password, so the
  // result is deterministic for the host suite.
  if (!haveSsid) return WifiJsonResult::MissingSsid;
  if (!havePw) return WifiJsonResult::MissingPassword;
  if (ssidOverflow) return WifiJsonResult::SsidTooLong;
  if (pwOverflow) return WifiJsonResult::PasswordTooLong;
  return WifiJsonResult::Ok;
}

// ===========================================================================
// 2. HttpServer (construction is always available)
// ===========================================================================

HttpServer::HttpServer(wifi::WiFiManager& wifi, ICalibrationState& calib)
    : wifi_(wifi), calib_(calib) {}

#if !defined(ARDUINO)

// Host build: no socket stack. begin()/serviceLoop() are inert so the class
// links into the Catch2 binary alongside the pure helpers above.
void HttpServer::begin() { started_ = true; }
void HttpServer::serviceLoop() {}

#endif  // !ARDUINO

// ===========================================================================
// 3. Real network handling (Arduino only)
// ===========================================================================
#if defined(ARDUINO)

namespace {

// Single listening socket, constructed lazily in begin(). Kept at file scope
// because WiFiServer has no default-reset method and the HttpServer instance
// is itself a singleton in practice (one per firmware image).
WiFiServer g_server(HTTP_PORT);

// Read the request line and headers from `client`, capturing Content-Length
// and the request-target. Returns false on timeout / malformed head.
//
// We only need the request line plus Content-Length, so we read header lines
// until the blank line, then (for POST) read exactly Content-Length bytes of
// body. Everything is bounded.
bool readRequestHead(WiFiClient& client, char* lineOut, std::size_t lineCap,
                     std::size_t& contentLength) {
  contentLength = 0;
  std::size_t lineLen = 0;
  bool gotRequestLine = false;

  // Generous per-request budget; the WiFiS3 client is line-buffered by the
  // co-processor so this rarely spins.
  const unsigned long deadline = millis() + 1000;

  char hdr[128];
  std::size_t hpos = 0;
  bool inRequestLine = true;

  while (millis() < deadline) {
    if (!client.connected() && client.available() == 0) break;
    while (client.available() > 0) {
      char c = static_cast<char>(client.read());
      if (c == '\r') continue;
      if (c == '\n') {
        hdr[hpos < sizeof(hdr) ? hpos : sizeof(hdr) - 1] = '\0';
        if (inRequestLine) {
          std::strncpy(lineOut, hdr, lineCap - 1);
          lineOut[lineCap - 1] = '\0';
          lineLen = boundedLen(lineOut, lineCap);
          (void)lineLen;
          gotRequestLine = true;
          inRequestLine = false;
        } else if (hpos == 0) {
          // Blank line: end of headers.
          return gotRequestLine;
        } else {
          // Parse Content-Length: case-insensitive header name.
          if (strncasecmp(hdr, "Content-Length:", 15) == 0) {
            const char* v = hdr + 15;
            while (*v == ' ') ++v;
            long n = atol(v);
            if (n < 0) n = 0;
            if (n > static_cast<long>(HTTP_BODY_MAX)) n = HTTP_BODY_MAX;
            contentLength = static_cast<std::size_t>(n);
          }
        }
        hpos = 0;
      } else if (hpos + 1 < sizeof(hdr)) {
        hdr[hpos++] = c;
      }
    }
  }
  return gotRequestLine;
}

}  // namespace

void HttpServer::begin() {
  g_server.begin();
  started_ = true;
}

void HttpServer::serviceLoop() {
  if (!started_) return;
  WiFiClient client = g_server.available();
  if (!client) return;
  handleClient(client);
  client.stop();
}

void HttpServer::handleClient(WiFiClient& client) {
  char line[HTTP_REQUEST_LINE_MAX];
  line[0] = '\0';
  std::size_t contentLength = 0;
  if (!readRequestHead(client, line, sizeof(line), contentLength)) {
    return;  // malformed / timed out; just drop the connection
  }

  HttpMethod method = HttpMethod::Unknown;
  char path[HTTP_PATH_MAX];
  if (!parseRequestLine(line, method, path, sizeof(path))) {
    client.println("HTTP/1.1 400 Bad Request");
    client.println("Connection: close");
    client.println();
    return;
  }

  // Route table mirrors Design §3.2.2.
  if (method == HttpMethod::Get && routeMatches(path, "/")) {
    handleGetIndex(client);
    return;
  }
  if (method == HttpMethod::Get && routeMatches(path, "/static/*")) {
    handleGetStatic(client);
    return;
  }
  if (method == HttpMethod::Get && routeMatches(path, "/api/info")) {
    handleGetInfo(client);
    return;
  }
  if (method == HttpMethod::Post && routeMatches(path, "/api/wifi")) {
    // Read exactly Content-Length bytes of body (bounded).
    char body[HTTP_BODY_MAX + 1];
    std::size_t got = 0;
    const unsigned long deadline = millis() + 1000;
    while (got < contentLength && millis() < deadline) {
      while (client.available() > 0 && got < contentLength) {
        body[got++] = static_cast<char>(client.read());
      }
    }
    body[got] = '\0';
    handlePostWifi(client, body);
    return;
  }

  // Method-aware fallback: a known path with the wrong verb is 405; anything
  // else is 404.
  const bool knownPath =
      routeMatches(path, "/") || routeMatches(path, "/static/*") ||
      routeMatches(path, "/api/info") || routeMatches(path, "/api/wifi");
  if (knownPath) {
    client.println("HTTP/1.1 405 Method Not Allowed");
  } else {
    client.println("HTTP/1.1 404 Not Found");
  }
  client.println("Connection: close");
  client.println();
}

void HttpServer::handleGetIndex(WiFiClient& client) {
#if ETCH_HAS_WEB_ASSETS
  // Stream the gzipped SPA blob straight from PROGMEM with the gzip encoding
  // header so the browser inflates it transparently (Design §2.4.4).
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/html; charset=utf-8");
  client.println("Content-Encoding: gzip");
  client.print("Content-Length: ");
  client.println(static_cast<unsigned long>(WEB_INDEX_GZ_LEN));
  client.println("Connection: close");
  client.println();
  // Copy out of PROGMEM in modest chunks to keep SRAM use flat.
  uint8_t buf[64];
  for (size_t off = 0; off < WEB_INDEX_GZ_LEN; off += sizeof(buf)) {
    const size_t n =
        (WEB_INDEX_GZ_LEN - off) < sizeof(buf) ? (WEB_INDEX_GZ_LEN - off)
                                               : sizeof(buf);
    for (size_t i = 0; i < n; ++i) {
      buf[i] = pgm_read_byte(&WEB_INDEX_GZ[off + i]);
    }
    client.write(buf, n);
  }
#else
  // Weak fallback before task 29.2 embeds the real bundle. Plain, uncompressed
  // HTML so the firmware is useful (and obviously diagnosable) without the
  // generated header.
  static const char kBootPage[] =
      "<!doctype html><html><head><meta charset=\"utf-8\">"
      "<title>Etch-a-Sketch</title></head><body>"
      "<h1>Firmware booting</h1>"
      "<p>Web assets are not embedded in this build "
      "(web_assets.h missing; see task 29.2).</p>"
      "</body></html>";
  client.println("HTTP/1.1 200 OK");
  client.println("Content-Type: text/html; charset=utf-8");
  client.print("Content-Length: ");
  client.println(static_cast<unsigned long>(sizeof(kBootPage) - 1));
  client.println("Connection: close");
  client.println();
  client.print(kBootPage);
#endif
}

void HttpServer::handleGetStatic(WiFiClient& client) {
#if ETCH_HAS_WEB_ASSETS
  // The current build inlines all assets into the single gzipped index, so
  // there are no separate /static/* objects to serve yet. Once the build emits
  // discrete assets this handler will look them up by path. For now, anything
  // under /static/ that is not the index is genuinely absent.
  client.println("HTTP/1.1 404 Not Found");
  client.println("Connection: close");
  client.println();
#else
  client.println("HTTP/1.1 404 Not Found");
  client.println("Connection: close");
  client.println();
#endif
}

void HttpServer::handleGetInfo(WiFiClient& client) {
  writeInfoJson(client, 200, "OK");
}

void HttpServer::writeInfoJson(WiFiClient& client, int statusCode,
                               const char* statusText) {
  // Build the JSON body with ArduinoJson (a platformio.ini dependency).
  // {"version","ip","rssi","hostname","calibrated"} per Design §3.2.2.
  JsonDocument doc;
  doc["version"] = ETCH_FW_VERSION;

  // In both STA and AP modes the WiFiS3 stack reports the active interface
  // address via WiFi.localIP() (the AP's own IP while in AP fallback).
  IPAddress ip = WiFi.localIP();
  char ipBuf[16];
  snprintf(ipBuf, sizeof(ipBuf), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
  doc["ip"] = ipBuf;
  doc["rssi"] = static_cast<int>(wifi_.rssiDbm());
  doc["hostname"] = ETCH_HOSTNAME;
  doc["calibrated"] = calib_.isCalibrated();

  char out[160];
  const size_t n = serializeJson(doc, out, sizeof(out));

  client.print("HTTP/1.1 ");
  client.print(statusCode);
  client.print(" ");
  client.println(statusText);
  client.println("Content-Type: application/json");
  client.print("Content-Length: ");
  client.println(static_cast<unsigned long>(n));
  client.println("Connection: close");
  client.println();
  client.write(reinterpret_cast<const uint8_t*>(out), n);
}

void HttpServer::handlePostWifi(WiFiClient& client, const char* body) {
  // Requirement 1.4 / Design §3.2.2: credential submission is honored only in
  // AP mode; reject with 409 Conflict otherwise.
  if (wifi_.mode() != wifi::WiFiManager::Mode::Ap) {
    static const char kBody[] =
        "{\"error\":\"wifi credentials accepted only in AP mode\"}";
    client.println("HTTP/1.1 409 Conflict");
    client.println("Content-Type: application/json");
    client.print("Content-Length: ");
    client.println(static_cast<unsigned long>(sizeof(kBody) - 1));
    client.println("Connection: close");
    client.println();
    client.print(kBody);
    return;
  }

  char ssid[wifi::WIFI_SSID_MAX_LEN + 1];
  char pw[wifi::WIFI_PASSWORD_MAX_LEN + 1];
  const WifiJsonResult pr =
      parseWifiJson(body, ssid, sizeof(ssid), pw, sizeof(pw));

  if (pr != WifiJsonResult::Ok) {
    const char* msg = "invalid request body";
    switch (pr) {
      case WifiJsonResult::MissingSsid:     msg = "missing ssid"; break;
      case WifiJsonResult::MissingPassword: msg = "missing password"; break;
      case WifiJsonResult::SsidTooLong:     msg = "ssid too long"; break;
      case WifiJsonResult::PasswordTooLong: msg = "password too long"; break;
      case WifiJsonResult::Malformed:       msg = "malformed json"; break;
      default: break;
    }
    JsonDocument doc;
    doc["error"] = msg;
    char out[96];
    const size_t n = serializeJson(doc, out, sizeof(out));
    client.println("HTTP/1.1 400 Bad Request");
    client.println("Content-Type: application/json");
    client.print("Content-Length: ");
    client.println(static_cast<unsigned long>(n));
    client.println("Connection: close");
    client.println();
    client.write(reinterpret_cast<const uint8_t*>(out), n);
    return;
  }

  // WiFiManager::saveCreds enforces the Requirement-1.4 length bounds
  // (SSID 1..32, password 8..63) and persists via NVM on success.
  if (!wifi_.saveCreds(ssid, pw)) {
    static const char kBody[] =
        "{\"error\":\"credentials failed validation "
        "(ssid 1-32, password 8-63 chars)\"}";
    client.println("HTTP/1.1 400 Bad Request");
    client.println("Content-Type: application/json");
    client.print("Content-Length: ");
    client.println(static_cast<unsigned long>(sizeof(kBody) - 1));
    client.println("Connection: close");
    client.println();
    client.print(kBody);
    return;
  }

  // Success: 200 with the assigned info snapshot.
  writeInfoJson(client, 200, "OK");
}

#endif  // ARDUINO

}  // namespace http
}  // namespace etch
