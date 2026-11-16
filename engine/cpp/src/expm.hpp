// The matrix exponential: Al-Mohy & Higham (2009) scaling and squaring with
// Padé approximants in the I + 2(V − U)⁻¹U form, the old core's expm.cc
// reimplemented on Eigen (ADR-0004), quirks included. Unlike the old core's,
// it takes only generators (each column summing to 0) and rescales each column
// of the result to sum to 1 after the Padé step and after each squaring, as a
// generator's exponential's columns do. The old core's squarings let them
// drift, which moved the lab's fitted peaks by up to 3e−2
// (tests/fixtures/golden/exact.json).
#ifndef ICMM_EXPM_HPP
#define ICMM_EXPM_HPP

#include "linalg.hpp"

namespace icmm {

class Expm {
 public:
  // Writes exp(t) to f, overwriting t, a generator times a duration. f is NaN
  // where exp(t) can't be computed: t isn't finite, the Padé denominator is
  // singular, or a column of the Padé step or a squaring sums further from 1
  // than rounding explains, as where t isn't a generator.
  void compute(Matrix& t, Matrix& f);

  // The last compute's Padé degree (3, 5, 7, 9 or 13) and squarings, or 0
  // and 0 where it stopped before choosing them.
  int degree() const { return degree_; }
  int squarings() const { return squarings_; }

 private:
  void pade(const Matrix& t, int m, Matrix& f);

  int degree_ = 0;
  int squarings_ = 0;

  Matrix t2_, t4_, t6_, t8_, t10_, u_, v_, w_, x_;
};

}  // namespace icmm

#endif  // ICMM_EXPM_HPP
