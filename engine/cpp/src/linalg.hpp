// Small dense matrices (at most ICMM_MAX_STATES square), stored inline so
// nothing touches the heap, and the two products the simulation runs.
//
// The products add their terms in the order reference BLAS does (dgemm and
// dgemv as the old core called them), so the port rounds like the build the
// goldens were frozen from.
#ifndef ICMM_LINALG_HPP
#define ICMM_LINALG_HPP

#include <Eigen/Core>

#include "icmm.h"

namespace icmm {

using Matrix = Eigen::Matrix<double, Eigen::Dynamic, Eigen::Dynamic, Eigen::ColMajor,
                             ICMM_MAX_STATES, ICMM_MAX_STATES>;
using Vector = Eigen::Matrix<double, Eigen::Dynamic, 1, Eigen::ColMajor, ICMM_MAX_STATES, 1>;

// c = a * b, each c(i, j) summed over k in order from 0.
inline void multiply(const Matrix& a, const Matrix& b, Matrix& c) {
  const Eigen::Index n = a.rows();
  c.setZero(n, n);
  for (Eigen::Index j = 0; j < n; ++j) {
    for (Eigen::Index k = 0; k < n; ++k) {
      const double bkj = b(k, j);
      for (Eigen::Index i = 0; i < n; ++i) c(i, j) += a(i, k) * bkj;
    }
  }
}

// y = a * x, each y(i) summed over j in order from 0.
inline void multiply(const Matrix& a, const Vector& x, Vector& y) {
  const Eigen::Index n = a.rows();
  y.setZero(n);
  for (Eigen::Index i = 0; i < n; ++i) {
    double sum = 0;
    for (Eigen::Index j = 0; j < n; ++j) sum += a(i, j) * x(j);
    y(i) = sum;
  }
}

}  // namespace icmm

#endif  // ICMM_LINALG_HPP
