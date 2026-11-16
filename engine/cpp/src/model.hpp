// One parameter vector on one topology: its generator at a voltage, and its
// steady state at the holding potential (ADR-0007; the old core's model.cc).
//
// The vector holds 2 values per state (s, sᵛ), then 2 per edge (e, eᵛ), then
// the sigmoid's a and b in mV. Every rate is exp(r + rᵛ·tanh((V + a) / b)),
// with r and rᵛ half the edge's parameter plus or minus the difference of its
// states' parameters, so the rates obey detailed balance by construction.
#ifndef ICMM_MODEL_HPP
#define ICMM_MODEL_HPP

#include <array>

#include "linalg.hpp"
#include "session.hpp"

namespace icmm {

class Model {
 public:
  Model(const Topology& topology, const double* params);

  // q = the generator at vm: q(j, i) is the rate from state i to state j, and
  // each column sums to 0.
  void generator(double vm, Matrix& q) const;

  // y = each state's share at equilibrium at vm.
  void steady_state(double vm, Vector& y) const;

  int open_state() const { return topology_.open_state; }

 private:
  double tanh_term(double vm) const;

  const Topology& topology_;
  const double* states_;  // 2 per state
  // Per edge: the forward rate's r and rᵛ, then the backward rate's.
  std::array<std::array<double, 4>, ICMM_MAX_STATES * (ICMM_MAX_STATES - 1) / 2> edges_;
  double a_;
  double b_;
};

}  // namespace icmm

#endif  // ICMM_MODEL_HPP
