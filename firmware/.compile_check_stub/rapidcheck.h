// Minimal stub of rapidcheck.h for compile/type verification only.
// NOT a real rapidcheck implementation. Provides just enough of the API
// surface that the firmware property tests use (rc::check, rc::gen::inRange,
// rc::gen::arbitrary, operator* on Gen, RC_ASSERT) so the test translation
// units can be type-checked when rapidcheck isn't installed locally.
#pragma once
#include <functional>
#include <string>
#include <tuple>

namespace rc {

template <typename T>
struct Gen {
  // operator* yields a value of T in real rapidcheck (sampled inside a
  // property). For type-checking we just return a default-constructed T.
  T operator*() const { return T{}; }
};

namespace gen {
template <typename T>
Gen<T> inRange(T /*lo*/, T /*hi*/) { return Gen<T>{}; }
template <typename T>
Gen<T> arbitrary() { return Gen<T>{}; }

// Compose generators into a tuple generator. Real rapidcheck samples each
// inner generator; for type-checking we yield a default-constructed tuple.
template <typename... Ts>
Gen<std::tuple<Ts...>> tuple(Gen<Ts>... /*gens*/) {
  return Gen<std::tuple<Ts...>>{};
}

// Generate a container (e.g. std::vector<T>) of elements drawn from `elem`.
// Real rapidcheck samples a random-length sequence; the stub yields a
// default-constructed (empty) container, exercising the empty-input boundary.
template <typename Container, typename T>
Gen<Container> container(Gen<T> /*elem*/) { return Gen<Container>{}; }
}  // namespace gen

template <typename F>
bool check(const std::string& /*desc*/, F&& f) {
  f();
  return true;
}

}  // namespace rc

// In real rapidcheck this records the failing expression and discards/fails the
// case. For type-checking, evaluate the condition (matching real rapidcheck's
// evaluation of the expression) so referenced helpers are genuinely ODR-used.
#define RC_ASSERT(expr) do { bool _rc_ok = static_cast<bool>(expr); (void)_rc_ok; } while (0)
