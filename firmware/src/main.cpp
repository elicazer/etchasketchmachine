// PlatformIO build entry point for the firmware sketch.
//
// PlatformIO's automatic .ino -> .ino.cpp conversion does not reliably land in
// the link line under this project's `src_dir = .` + custom `build_src_filter`
// layout, which left `setup()` / `loop()` undefined at link time. To keep a
// single source of truth (etchasketch.ino is still the canonical sketch and is
// what arduino-cli compiles), this translation unit simply includes the sketch
// so its ARDUINO-guarded setup()/loop() are compiled into the firmware image.
//
// The sketch lives at the firmware root; its quote-includes ("src/...") resolve
// relative to the sketch's own directory, so they remain correct when pulled in
// from here.
#include "../etchasketch.ino"
