#include "model.hpp"

#include <cmath>

namespace icmm {

Model::Model(const Topology& topology, const double* params)
    : topology_(topology), states_(params) {
  const int n = topology.num_states;
  const double* edge_params = params + 2 * n;
  for (size_t i = 0; i < topology.edges.size(); ++i) {
    const Edge& e = topology.edges[i];
    for (int k = 0; k < 2; ++k) {
      const double difference = states_[2 * e.to + k] - states_[2 * e.from + k];
      const double edge = edge_params[2 * i + k];
      edges_[i][k] = 0.5 * (edge + difference);
      edges_[i][2 + k] = 0.5 * (edge - difference);
    }
  }
  a_ = params[2 * n + 2 * static_cast<int>(topology.edges.size())];
  b_ = params[2 * n + 2 * static_cast<int>(topology.edges.size()) + 1];
}

double Model::tanh_term(double vm) const { return std::tanh((vm + a_) / b_); }

void Model::generator(double vm, Matrix& q) const {
  const int n = topology_.num_states;
  const double v = tanh_term(vm);
  q.setZero(n, n);
  for (size_t i = 0; i < topology_.edges.size(); ++i) {
    const Edge& e = topology_.edges[i];
    const double forward = std::exp(edges_[i][0] + edges_[i][1] * v);
    const double backward = std::exp(edges_[i][2] + edges_[i][3] * v);
    q(e.from, e.from) -= forward;
    q(e.to, e.to) -= backward;
    q(e.to, e.from) += forward;
    q(e.from, e.to) += backward;
  }
}

void Model::steady_state(double vm, Vector& y) const {
  const int n = topology_.num_states;
  const double v = tanh_term(vm);
  y.resize(n);
  double sum = 0;
  for (int i = 0; i < n; ++i) {
    y(i) = std::exp(states_[2 * i] + states_[2 * i + 1] * v);
    sum += y(i);
  }
  y *= 1.0 / sum;
}

}  // namespace icmm
