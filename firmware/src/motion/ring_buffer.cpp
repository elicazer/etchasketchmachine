// Translation unit for the SPSC command ring buffer (Task 6.5).
//
// RingBuffer<T, Capacity> is a header-only template (ring_buffer.h) because the
// motion planner instantiates it with DrawingCommand while the host tests
// instantiate it with int, and templates must be visible at every
// instantiation site. There is therefore no per-instance runtime code to
// define here.
//
// This .cpp exists for two reasons:
//   1. The task asks for a ring_buffer.cpp so the module has a build-system
//      anchor consistent with the other motion sources (bresenham.cpp,
//      ramp.cpp) picked up by `build_src_filter = +<src/>`.
//   2. The explicit instantiation below forces the compiler to fully
//      type-check RingBuffer<DrawingCommand, COMMAND_BUFFER_SIZE> in a real
//      translation unit -- catching any layout or trivially-assignable issue
//      with the firmware element type at firmware build time rather than only
//      when the planner first uses it.
//
// References: Requirements 6.4, 6.5; Design §3.2.5, §6.4.

#include "ring_buffer.h"

#include "../types.h"

namespace etch {
namespace motion {

// Explicit instantiation of the firmware-facing buffer type. The motion
// planner (Task 6.9) uses this exact instantiation to queue decoded commands
// between the protocol layer and the GPT timer ISR.
template class RingBuffer<DrawingCommand, COMMAND_BUFFER_SIZE>;

}  // namespace motion
}  // namespace etch
