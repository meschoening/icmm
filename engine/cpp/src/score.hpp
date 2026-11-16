// Scoring one parameter vector against one protocol: simulate each point's
// sweep, measure it (ADR-0010), and sum the squared errors over train and
// validation points.
#ifndef ICMM_SCORE_HPP
#define ICMM_SCORE_HPP

#include <cstddef>
#include <cstdint>
#include <vector>

#include "expm.hpp"
#include "icmm.h"
#include "linalg.hpp"
#include "model.hpp"
#include "session.hpp"

namespace icmm {

// One thread's scratch space, sized for a session's protocols.
struct Workspace {
  explicit Workspace(const icmm_session& session);

  Expm expm;
  Matrix q, e, q_last, e_last;
  Vector holding, y, next;
  std::vector<double> open;    // the measured step's open probability
  std::vector<double> values;  // each point's measure
  std::vector<char> failed;    // each point's sweep failed
};

// Where point_values writes each sweep's trace, thinned as icmm_simulate says,
// moving on past each one it writes.
struct TraceSink {
  int max_samples;
  int32_t* lengths;
  double* time_ms;
  double* open;
};

// How many moments the measured step of point i's sweep records.
int recorded_count(const Protocol& protocol, size_t i);

// How many of a sweep's n recorded moments its trace keeps.
int trace_length(int n, int max_samples);

// Fills ws.values with each point's value as its score compares it with the
// point's data, divided as the protocol is normalized, and ws.failed with
// whether its sweep failed; with a sink, writes each sweep's trace to it.
void point_values(const Model& model, const Protocol& protocol, Workspace& ws,
                  TraceSink* traces = nullptr);

// The protocol's score from the values point_values left in ws.
icmm_protocol_score score_values(const Protocol& protocol, const Workspace& ws);

icmm_protocol_score score_protocol(const Model& model, const Protocol& protocol, Workspace& ws);

}  // namespace icmm

#endif  // ICMM_SCORE_HPP
