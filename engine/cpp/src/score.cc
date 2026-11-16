#include "score.hpp"

#include <algorithm>
#include <cmath>

#include "measure.hpp"

namespace icmm {

Workspace::Workspace(const icmm_session& session) {
  size_t most_recorded = 1;
  size_t most_points = 1;
  for (const Protocol& p : session.protocols) {
    most_recorded = std::max(most_recorded, static_cast<size_t>(p.max_recorded));
    most_points = std::max(most_points, p.x.size());
  }
  open.resize(most_recorded);
  values.resize(most_points);
  failed.resize(most_points);
}

namespace {

// Writes the moments of rec that its trace keeps to the sink, and moves past
// them.
void write_trace(const Recording& rec, TraceSink& sink) {
  const int kept = trace_length(rec.n, sink.max_samples);
  const int stride = kept == rec.n ? 1 : (rec.n - 1 + sink.max_samples - 1) / sink.max_samples;
  for (int j = 0; j < kept; ++j) {
    const int k = j == kept - 1 ? rec.n - 1 : j * stride;
    *sink.time_ms++ = rec.time(k);
    *sink.open++ = rec.open[k];
  }
  *sink.lengths++ = kept;
}

// Simulates point i's sweep from the holding state through its measured step,
// whose open probability goes to ws.open; later steps can't change it. Returns
// false if a recorded value isn't finite.
bool record_sweep(const Model& model, const Protocol& p, size_t i, Workspace& ws,
                  Recording& rec) {
  ws.y = ws.holding;
  for (int j = 0; j <= p.measured_step; ++j) {
    double vm = p.step_voltage_mV[j];
    double duration = p.step_duration_ms[j];
    if (j == p.swept_step) (p.swept_quantity == ICMM_SWEPT_VOLTAGE ? vm : duration) = p.x[i];
    model.generator(vm, ws.q);
    if (j < p.measured_step) {
      ws.q *= duration;
      ws.expm.compute(ws.q, ws.e);
      multiply(ws.e, ws.y, ws.next);
      ws.y.swap(ws.next);
      continue;
    }
    const double h = p.time_resolution_ms;
    const int n = static_cast<int>(recorded_moments(duration, h));
    rec = Recording{ws.open.data(), n, h, duration};
    // The last interval is shorter when the duration isn't a whole number of
    // time resolutions.
    const double last_ms = last_interval(duration, h);
    const bool shorter = last_ms != h;
    if (shorter) ws.q_last = ws.q * last_ms;
    ws.q *= h;
    ws.expm.compute(ws.q, ws.e);
    if (shorter) ws.expm.compute(ws.q_last, ws.e_last);
    ws.open[0] = ws.y(model.open_state());
    for (int k = 1; k < n; ++k) {
      multiply(k == n - 1 && shorter ? ws.e_last : ws.e, ws.y, ws.next);
      ws.y.swap(ws.next);
      ws.open[k] = ws.y(model.open_state());
    }
  }
  return std::all_of(ws.open.begin(), ws.open.begin() + rec.n,
                     [](double v) { return std::isfinite(v); });
}

// The largest of 0 and the values of the points `in` picks that didn't fail.
template <class In>
double largest(const Protocol& p, const Workspace& ws, In in) {
  double top = 0;
  for (size_t i = 0; i < p.x.size(); ++i) {
    if (in(i) && !ws.failed[i]) top = std::max(top, ws.values[i]);
  }
  return top;
}

}  // namespace

int recorded_count(const Protocol& p, size_t i) {
  const bool swept = p.swept_step == p.measured_step && p.swept_quantity == ICMM_SWEPT_DURATION;
  const double duration = swept ? p.x[i] : p.step_duration_ms[p.measured_step];
  return static_cast<int>(recorded_moments(duration, p.time_resolution_ms));
}

int trace_length(int n, int max_samples) {
  if (n - 1 <= max_samples) return n;
  const int stride = (n - 1 + max_samples - 1) / max_samples;
  return (n - 1 + stride - 1) / stride + 1;
}

void point_values(const Model& model, const Protocol& p, Workspace& ws, TraceSink* traces) {
  model.steady_state(p.holding_mV, ws.holding);
  const size_t points = p.x.size();
  for (size_t i = 0; i < points; ++i) {
    Recording rec{};
    const bool recorded = record_sweep(model, p, i, ws, rec);
    if (traces != nullptr) write_trace(rec, *traces);
    if (!recorded) {
      ws.failed[i] = 1;
      continue;
    }
    double& v = ws.values[i];
    switch (p.measure) {
      case ICMM_MEASURE_PEAK:
        v = peak(rec);
        break;
      case ICMM_MEASURE_DECAY_TIME:
        v = decay_time(rec, p.decay_from, p.decay_to);
        break;
      default:  // ICMM_MEASURE_TIME_TO_PEAK
        v = time_to_peak(rec);
        break;
    }
    ws.failed[i] = !std::isfinite(v);
  }
  if (!p.normalized) return;

  // Train values are normalized by the largest train value, validation values
  // by the largest of all.
  const double train_top = largest(p, ws, [&](size_t i) { return !p.validation[i]; });
  const double all_top = largest(p, ws, [](size_t) { return true; });
  for (size_t i = 0; i < points; ++i) {
    const double top = p.validation[i] ? all_top : train_top;
    if (top == 0) {
      ws.failed[i] = 1;
    } else if (!ws.failed[i]) {
      ws.values[i] /= top;
    }
  }
}

icmm_protocol_score score_protocol(const Model& model, const Protocol& p, Workspace& ws) {
  point_values(model, p, ws);
  return score_values(p, ws);
}

icmm_protocol_score score_values(const Protocol& p, const Workspace& ws) {
  icmm_protocol_score score{};
  for (size_t i = 0; i < p.x.size(); ++i) {
    const bool val = p.validation[i] != 0;
    (val ? score.val_points : score.train_points) += 1;
    if (ws.failed[i]) {
      (val ? score.val_failed : score.train_failed) += 1;
      continue;
    }
    const double d = ws.values[i] - p.value[i];
    (val ? score.val_sse : score.train_sse) += d * d;
  }
  return score;
}

}  // namespace icmm
