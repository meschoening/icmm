// What a measured step reports per sweep, from its recorded open probability
// (ADR-0010): its peak, a decay time, or its time to peak.
#ifndef ICMM_MEASURE_HPP
#define ICMM_MEASURE_HPP

#include <algorithm>
#include <cmath>

namespace icmm {

// The intervals of its time resolution a measured step takes to its end, and
// whether its duration is a whole number of them: within 1e-12 (relative)
// counts as whole, so rounding in duration ÷ resolution never adds one. When it
// isn't, the last interval is shorter (ADR-0010).
struct Intervals {
  double count;
  bool whole;
};

inline Intervals intervals(double duration_ms, double time_resolution_ms) {
  const double count = duration_ms / time_resolution_ms;
  const double nearest = std::nearbyint(count);
  if (std::fabs(count - nearest) <= 1e-12 * std::max(std::fabs(count), std::fabs(nearest))) {
    return {nearest, true};
  }
  return {std::ceil(count), false};
}

// Moments a measured step records: its first, then one each time resolution to
// its end, as icmm.dataset.recorded_moments counts them.
inline double recorded_moments(double duration_ms, double time_resolution_ms) {
  return intervals(duration_ms, time_resolution_ms).count + 1;
}

// The time between a measured step's last two recorded moments.
inline double last_interval(double duration_ms, double time_resolution_ms) {
  const Intervals steps = intervals(duration_ms, time_resolution_ms);
  return steps.whole ? time_resolution_ms : duration_ms - (steps.count - 1) * time_resolution_ms;
}

// A measured step's recorded open probability: n moments, one time resolution
// apart from the step's start but for the last, at its end.
struct Recording {
  const double* open;
  int n;
  double step_ms;
  double end_ms;

  double time(int k) const { return k < n - 1 ? k * step_ms : end_ms; }
};

// The highest recorded open probability.
double peak(const Recording& rec);

// The time, in ms, the open probability takes to fall from one fraction of the
// peak to another, each fraction's time the moment it falls through it for
// good (staying below to the step's end), placed between recorded moments by
// a straight line. With the fractions running upward, the time it takes to
// rise through them for good before the peak, from the step's start if it
// starts above one and stays there. A decay that ends above a fraction is
// extrapolated as an exponential, from the first fraction's time (or the
// peak, if it ends above that too) through the last moment. No decay at all
// takes 1,000,000 times the time resolution, which caps the extrapolation
// too. NaN if the peak is 0.
double decay_time(const Recording& rec, double from, double to);

// The time of the highest recorded moment, in ms, placed by a parabola through
// it and its two neighbors: 0 at the step's first moment, and the step's end
// at its last.
double time_to_peak(const Recording& rec);

}  // namespace icmm

#endif  // ICMM_MEASURE_HPP
