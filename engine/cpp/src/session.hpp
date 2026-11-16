// A session's own copy of its topology and protocols, checked once when it's
// created so scoring never has to check them again.
#ifndef ICMM_SESSION_HPP
#define ICMM_SESSION_HPP

#include <cstdint>
#include <string>
#include <vector>

#include "icmm.h"

namespace icmm {

struct Edge {
  int from;
  int to;
};

struct Topology {
  int num_states = 0;
  std::vector<Edge> edges;
  int open_state = 0;

  int param_count() const { return 2 * num_states + 2 * static_cast<int>(edges.size()) + 2; }
};

struct Protocol {
  double holding_mV = 0;
  std::vector<double> step_voltage_mV;
  std::vector<double> step_duration_ms;
  int swept_step = 0;
  int swept_quantity = 0;
  int measured_step = 0;
  int measure = 0;
  double decay_from = 0;
  double decay_to = 0;
  double time_resolution_ms = 0;
  bool normalized = false;
  std::vector<double> x;
  std::vector<double> value;
  std::vector<std::uint8_t> validation;
  int max_recorded = 0;  // the most moments the measured step records in any sweep
};

// Thrown by the checks with a sentence for icmm_last_error().
struct InvalidArgument {
  std::string message;
};

Topology copy_topology(const icmm_topology& topology);
Protocol copy_protocol(const icmm_protocol& protocol, int index);

}  // namespace icmm

struct icmm_session {
  icmm::Topology topology;
  std::vector<icmm::Protocol> protocols;
};

#endif  // ICMM_SESSION_HPP
