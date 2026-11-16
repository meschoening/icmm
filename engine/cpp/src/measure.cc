#include "measure.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace icmm {

namespace {

// The time after which the recording stays at or below `level` (falling) or
// at or above it (rising) from there through moment `last`, placed by a
// straight line between the last moment on the other side and the next; at
// moment `first` if none from it on is on the other side. Returns false if
// moment `last` itself is.
bool settled(const Recording& rec, int first, int last, double level, bool falling, double& t) {
  const double* x = rec.open;
  auto beyond = [&](double v) { return falling ? v > level : v < level; };
  if (beyond(x[last])) return false;
  int k = last;
  while (k > first && !beyond(x[k - 1])) --k;
  if (k == first) {
    t = rec.time(first);
  } else {
    // x[k − 1] is beyond the level and x[k] isn't, so they differ.
    const double t0 = rec.time(k - 1);
    t = t0 + (rec.time(k) - t0) * (x[k - 1] - level) / (x[k - 1] - x[k]);
  }
  return true;
}

}  // namespace

double peak(const Recording& rec) { return *std::max_element(rec.open, rec.open + rec.n); }

double decay_time(const Recording& rec, double from, double to) {
  const int top = static_cast<int>(std::max_element(rec.open, rec.open + rec.n) - rec.open);
  const double peak = rec.open[top];
  if (!(peak > 0)) return std::numeric_limits<double>::quiet_NaN();
  double t1 = 0, t2 = 0;
  if (from < to) {
    // A rise settles above both fractions by the peak.
    settled(rec, 0, top, from * peak, false, t1);
    settled(rec, 0, top, to * peak, false, t2);
    return t2 - t1;
  }

  const double cap = 1e6 * rec.step_ms;
  const int last = rec.n - 1;
  // The exponential through (t, level) and the last moment, from `from` to
  // `to`; a last moment that hasn't fallen below the level never decays.
  auto extrapolated = [&](double t, double level) {
    const double end = rec.open[last];
    if (!(end < level)) return cap;
    return std::min(cap, (rec.time(last) - t) * std::log(from / to) / std::log(level / end));
  };
  if (!settled(rec, top, last, from * peak, true, t1)) return extrapolated(rec.time(top), peak);
  if (!settled(rec, top, last, to * peak, true, t2)) return extrapolated(t1, from * peak);
  return t2 - t1;
}

double time_to_peak(const Recording& rec) {
  const int k = static_cast<int>(std::max_element(rec.open, rec.open + rec.n) - rec.open);
  if (k == 0 || k == rec.n - 1) return rec.time(k);
  // The parabola's vertex. The first highest moment is above the one before
  // it, so the denominator is positive and the vertex lies between them.
  const double t0 = rec.time(k - 1), t1 = rec.time(k), t2 = rec.time(k + 1);
  const double y0 = rec.open[k - 1], y1 = rec.open[k], y2 = rec.open[k + 1];
  const double right = (t1 - t0) * (y1 - y2);
  const double left = (t1 - t2) * (y1 - y0);
  return t1 - 0.5 * ((t1 - t0) * right - (t1 - t2) * left) / (right - left);
}

}  // namespace icmm
