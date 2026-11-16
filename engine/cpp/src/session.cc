#include "session.hpp"

#include <algorithm>
#include <cmath>
#include <string>

#include "measure.hpp"

namespace icmm {

namespace {

[[noreturn]] void invalid(std::string message) { throw InvalidArgument{std::move(message)}; }

void require(bool ok, const std::string& where, const char* what) {
  if (!ok) invalid(where + what);
}

}  // namespace

Topology copy_topology(const icmm_topology& t) {
  require(t.num_states >= 1 && t.num_states <= ICMM_MAX_STATES, "topology: ",
          "it must have 1 to 16 states.");
  const int max_edges = t.num_states * (t.num_states - 1) / 2;
  require(t.num_edges >= 0 && t.num_edges <= max_edges, "topology: ",
          "it has more edges than its states can have.");
  require(t.num_edges == 0 || t.edges != nullptr, "topology: ", "its edges are missing.");
  require(t.open_state >= 0 && t.open_state < t.num_states, "topology: ",
          "the open state isn't one of its states.");
  Topology out;
  out.num_states = t.num_states;
  out.open_state = t.open_state;
  out.edges.reserve(static_cast<size_t>(t.num_edges));
  for (int i = 0; i < t.num_edges; ++i) {
    const int a = t.edges[2 * i];
    const int b = t.edges[2 * i + 1];
    require(a >= 0 && a < t.num_states && b >= 0 && b < t.num_states && a != b,
            "topology: edge " + std::to_string(i) + ": ",
            "it must join two different states of the topology.");
    out.edges.push_back({a, b});
  }
  return out;
}

Protocol copy_protocol(const icmm_protocol& p, int index) {
  const std::string where = "protocol " + std::to_string(index) + ": ";
  require(std::isfinite(p.holding_mV), where, "the holding potential must be finite.");
  require(p.num_steps >= 1, where, "it needs at least one step.");
  require(p.step_voltage_mV != nullptr && p.step_duration_ms != nullptr, where,
          "its steps are missing.");
  require(p.swept_step >= 0 && p.swept_step < p.num_steps, where,
          "the swept step isn't one of its steps.");
  require(p.swept_quantity == ICMM_SWEPT_VOLTAGE || p.swept_quantity == ICMM_SWEPT_DURATION,
          where, "the swept quantity must be a voltage or a duration.");
  require(p.measured_step >= 0 && p.measured_step < p.num_steps, where,
          "the measured step isn't one of its steps.");
  require(p.measure == ICMM_MEASURE_PEAK || p.measure == ICMM_MEASURE_DECAY_TIME ||
              p.measure == ICMM_MEASURE_TIME_TO_PEAK,
          where, "the measure must be a peak, a decay time or a time to peak.");
  require(std::isfinite(p.time_resolution_ms) && p.time_resolution_ms > 0, where,
          "the time resolution must be above 0 ms.");
  require(!(p.measure == ICMM_MEASURE_TIME_TO_PEAK && p.normalized), where,
          "a time to peak can't be normalized.");
  if (p.measure == ICMM_MEASURE_DECAY_TIME) {
    auto fraction = [](double f) { return std::isfinite(f) && f > 0 && f <= 1; };
    require(fraction(p.decay_from) && fraction(p.decay_to), where,
            "a decay time's fractions must be above 0 and at most 1.");
    require(p.decay_from != p.decay_to, where, "a decay time's fractions must differ.");
  }
  require(p.num_points >= 1, where, "it needs at least one point.");
  require(p.x != nullptr && p.value != nullptr && p.validation != nullptr, where,
          "its points are missing.");

  Protocol out;
  out.holding_mV = p.holding_mV;
  out.step_voltage_mV.assign(p.step_voltage_mV, p.step_voltage_mV + p.num_steps);
  out.step_duration_ms.assign(p.step_duration_ms, p.step_duration_ms + p.num_steps);
  out.swept_step = p.swept_step;
  out.swept_quantity = p.swept_quantity;
  out.measured_step = p.measured_step;
  out.measure = p.measure;
  out.decay_from = p.decay_from;
  out.decay_to = p.decay_to;
  out.time_resolution_ms = p.time_resolution_ms;
  out.normalized = p.normalized != 0;
  out.x.assign(p.x, p.x + p.num_points);
  out.value.assign(p.value, p.value + p.num_points);
  out.validation.assign(p.validation, p.validation + p.num_points);

  const bool swept_voltage = p.swept_quantity == ICMM_SWEPT_VOLTAGE;
  for (int j = 0; j < p.num_steps; ++j) {
    const bool voltage_swept = swept_voltage && j == p.swept_step;
    const bool duration_swept = !swept_voltage && j == p.swept_step;
    require(voltage_swept || std::isfinite(out.step_voltage_mV[j]),
            where + "step " + std::to_string(j) + ": ", "its voltage must be finite.");
    const double d = out.step_duration_ms[j];
    require(duration_swept || (std::isfinite(d) && d > 0),
            where + "step " + std::to_string(j) + ": ", "its duration must be above 0 ms.");
  }
  for (int i = 0; i < p.num_points; ++i) {
    const std::string at = where + "point " + std::to_string(i) + ": ";
    require(std::isfinite(out.x[i]) && std::isfinite(out.value[i]), at,
            "its x and value must be finite.");
    require(out.validation[i] <= 1, at, "its validation mark must be 0 or 1.");
    require(swept_voltage || out.x[i] > 0, at, "a swept duration must be above 0 ms.");
  }

  // The measured step's moments, in its longest sweep, must fit the recorder.
  double longest = out.step_duration_ms[p.measured_step];
  if (!swept_voltage && p.swept_step == p.measured_step) {
    longest = *std::max_element(out.x.begin(), out.x.end());
  }
  const double moments = recorded_moments(longest, out.time_resolution_ms);
  require(moments <= ICMM_MAX_RECORDED, where,
          "the measured step would record more than 1,000,000 moments.");
  out.max_recorded = static_cast<int>(moments);
  return out;
}

}  // namespace icmm
