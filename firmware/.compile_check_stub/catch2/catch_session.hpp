// Stub of catch_session.hpp for compile verification only.
#pragma once
#include "catch_test_macros.hpp"

namespace Catch {
class Session {
 public:
  int run(int /*argc*/, char* /*argv*/[]) {
    int failures = 0;
    for (auto& tc : etch_test_stub::registry()) {
      try { tc.body(); }
      catch (...) { ++failures; }
    }
    return failures;
  }
};
}
