// Minimal stub of catch_test_macros.hpp for compile verification only.
// NOT a real Catch2 implementation. Provides just enough to type-check
// firmware host tests when Catch2 isn't installed locally.
#pragma once
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <functional>
#include <cstdlib>

namespace etch_test_stub {
struct TestCase { std::string name; std::string tags; std::function<void()> body; };
inline std::vector<TestCase>& registry() { static std::vector<TestCase> r; return r; }
struct Registrar { Registrar(const char* n, const char* t, std::function<void()> b) { registry().push_back({n, t, std::move(b)}); } };
}

#define CATCH_INTERNAL_CONCAT2(a,b) a##b
#define CATCH_INTERNAL_CONCAT(a,b) CATCH_INTERNAL_CONCAT2(a,b)
#define TEST_CASE(name, tags) \
  static void CATCH_INTERNAL_CONCAT(stub_test_, __LINE__)(); \
  static ::etch_test_stub::Registrar CATCH_INTERNAL_CONCAT(stub_reg_, __LINE__)(name, tags, CATCH_INTERNAL_CONCAT(stub_test_, __LINE__)); \
  static void CATCH_INTERNAL_CONCAT(stub_test_, __LINE__)()

#define REQUIRE(expr) do { if (!(expr)) { std::cerr << "REQUIRE FAIL: " #expr << "\n"; std::abort(); } } while(0)
#define CHECK(expr) do { if (!(expr)) { std::cerr << "CHECK FAIL: " #expr << "\n"; } } while(0)
#define REQUIRE_FALSE(expr) REQUIRE(!(expr))
#define CHECK_FALSE(expr) CHECK(!(expr))
#define INFO(msg) do { std::ostringstream _info_oss; _info_oss << msg; (void)_info_oss; } while(0)
#define CAPTURE(...) do {} while(0)
