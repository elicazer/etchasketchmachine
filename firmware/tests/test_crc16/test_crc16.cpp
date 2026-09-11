// Host-side unit tests for the CRC-16/CCITT shared utility (Task 1.4).
//
// Validates well-known check vectors against the implementation in
// firmware/src/protocol/crc16.cpp. Run with:
//
//     pio test -e host_test
//
// The host_test environment in platformio.ini is configured with
// `test_build_src = no`, so this translation unit pulls the implementation
// in directly to keep the test binary self-contained. The protocol header
// is reachable through `include_dir = src`.

#include <catch2/catch_session.hpp>
#include <catch2/catch_test_macros.hpp>

#include <cstdint>

// Pull the header and implementation in via relative paths so the test does
// not depend on the host_test environment inheriting `include_dir = src`.
#include "../../src/protocol/crc16.h"
#include "../../src/protocol/crc16.cpp"  // NOLINT(bugprone-suspicious-include)

using etch::protocol::crc16_ccitt;

TEST_CASE("crc16_ccitt: empty input yields the initial value", "[crc16]") {
    REQUIRE(crc16_ccitt(nullptr, 0) == 0xFFFF);

    const uint8_t buf[1] = {0};
    REQUIRE(crc16_ccitt(buf, 0) == 0xFFFF);
}

TEST_CASE("crc16_ccitt: canonical 123456789 check vector", "[crc16]") {
    // Catalogue check value for CRC-16/CCITT-FALSE.
    // See https://reveng.sourceforge.io/crc-catalogue/16.htm
    const uint8_t input[] = {'1', '2', '3', '4', '5', '6', '7', '8', '9'};
    REQUIRE(crc16_ccitt(input, sizeof(input)) == 0x29B1);
}

TEST_CASE("crc16_ccitt: single zero byte", "[crc16]") {
    // Hand-derived from the algorithm: starting at 0xFFFF, processing
    // a single 0x00 byte yields 0xE1F0.
    const uint8_t input[] = {0x00};
    REQUIRE(crc16_ccitt(input, sizeof(input)) == 0xE1F0);
}

TEST_CASE("crc16_ccitt: deterministic and length-sensitive", "[crc16]") {
    const uint8_t a[] = {0xDE, 0xAD, 0xBE, 0xEF};
    const uint8_t b[] = {0xDE, 0xAD, 0xBE, 0xEF, 0x00};

    const uint16_t crc_a_first = crc16_ccitt(a, sizeof(a));
    const uint16_t crc_a_again = crc16_ccitt(a, sizeof(a));
    REQUIRE(crc_a_first == crc_a_again);
    REQUIRE(crc_a_first != crc16_ccitt(b, sizeof(b)));
}

TEST_CASE("crc16_ccitt: bit flip changes the digest", "[crc16]") {
    uint8_t input[16] = {0};
    for (uint8_t i = 0; i < sizeof(input); ++i) {
        input[i] = static_cast<uint8_t>(i);
    }
    const uint16_t baseline = crc16_ccitt(input, sizeof(input));

    input[7] ^= 0x01;  // flip a single bit somewhere in the middle
    const uint16_t mutated = crc16_ccitt(input, sizeof(input));

    REQUIRE(baseline != mutated);
}

int main(int argc, char* argv[]) {
    return Catch::Session().run(argc, argv);
}
