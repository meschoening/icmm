#include "expm.hpp"

#include "inverse.hpp"

#include <algorithm>
#include <cmath>
#include <limits>

namespace icmm {

namespace {

constexpr double kNaN = std::numeric_limits<double>::quiet_NaN();

// Largest 1-norm the Padé degree m keeps accurate, for m = 3, 5, 7, 9, 13.
constexpr double kTheta[] = {1.495585217958292e-2, 2.539398330063230e-1, 9.504178996162932e-1,
                             2.097847961257068e0, 5.371920351148152e0};

// Coefficients of the [m/m] Padé approximant's numerator.
constexpr double kB3[] = {120.0, 60.0, 12.0, 1.0};
constexpr double kB5[] = {30240.0, 15120.0, 3360.0, 420.0, 30.0, 1.0};
constexpr double kB7[] = {17297280.0, 8648640.0, 1995840.0, 277200.0,
                          25200.0,    1512.0,    56.0,      1.0};
constexpr double kB9[] = {17643225600.0, 8821612800.0, 2075673600.0, 302702400.0, 30270240.0,
                          2162160.0,     110880.0,     3960.0,       90.0,        1.0};
constexpr double kB13[] = {64764752532480000.0, 32382376266240000.0, 7771770303897600.0,
                           1187353796428800.0,  129060195264000.0,   10559470521600.0,
                           670442572800.0,      33522128640.0,       1323241920.0,
                           40840800.0,          960960.0,            16380.0,
                           182.0,               1.0};

// The largest column sum of |a|. A column whose sum isn't a number never
// wins, and an infinite norm is held to 1.7e308, as the old norm1 did.
double norm1(const Matrix& a) {
  double largest = 0;
  for (Eigen::Index j = 0; j < a.cols(); ++j) {
    double sum = 0;
    for (Eigen::Index i = 0; i < a.rows(); ++i) sum += std::fabs(a(i, j));
    if (sum >= largest) largest = sum;
  }
  return std::isinf(largest) ? 1.7e308 : largest;
}

void halve(Matrix& a, int times) { a /= std::pow(2.0, times); }

// How far from 1 a column of the Padé step or a squaring may sum and still be
// rescaled. Rescaled at every step, a generator's columns stay within a few
// ulps of 1; further off, t isn't a generator, or the Padé step is too far
// outside its range to resolve it (squarings capped where t's powers overflow).
constexpr double kColumnSumGuard = 1e-6;

// Divides each column of f by its sum, so it sums to 1 as a generator's
// exponential does (ADR-0004), each sum added in order from row 0. Returns
// false, with f NaN, if a column's sum is further than the guard from 1 or
// isn't a number.
bool renormalize(Matrix& f) {
  const Eigen::Index n = f.rows();
  for (Eigen::Index j = 0; j < n; ++j) {
    double sum = 0;
    for (Eigen::Index i = 0; i < n; ++i) sum += f(i, j);
    if (!(std::fabs(sum - 1) <= kColumnSumGuard)) {
      f.setConstant(n, n, kNaN);
      return false;
    }
    for (Eigen::Index i = 0; i < n; ++i) f(i, j) /= sum;
  }
  return true;
}

}  // namespace

void Expm::compute(Matrix& t, Matrix& f) {
  const Eigen::Index n = t.rows();
  degree_ = 0;
  squarings_ = 0;
  if (!t.allFinite()) {
    f.setConstant(n, n, kNaN);
    return;
  }
  multiply(t, t, t2_);
  multiply(t2_, t2_, t4_);
  multiply(t4_, t2_, t6_);
  const double d4 = std::pow(norm1(t4_), 0.25);
  const double d6 = std::pow(norm1(t6_), 0.1667);  // sic: the old core's sixth root
  const double eta1 = std::max(d4, d6);

  int m = 13;
  int s = 0;
  if (eta1 <= kTheta[0]) {
    m = 3;
  } else if (eta1 <= kTheta[1]) {
    m = 5;
  } else {
    multiply(t4_, t4_, t8_);
    const double d8 = std::pow(norm1(t8_), 0.125);
    const double eta3 = std::max(d6, d8);
    if (eta3 <= kTheta[2]) {
      m = 7;
    } else if (eta3 <= kTheta[3]) {
      m = 9;
    } else {
      multiply(t8_, t2_, t10_);
      const double d10 = std::pow(norm1(t10_), 0.1);
      const double eta5 = std::min(eta3, std::max(d8, d10));
      const double squarings = std::max(std::ceil(std::log2(eta5 / kTheta[4])), 0.0);
      if (!(squarings < 1024)) {
        f.setConstant(n, n, kNaN);
        return;
      }
      s = static_cast<int>(squarings);
    }
  }

  degree_ = m;
  squarings_ = s;
  if (s != 0) {
    halve(t, s);
    halve(t2_, 2 * s);
    halve(t4_, 4 * s);
    halve(t6_, 6 * s);
  }
  pade(t, m, f);
  if (!renormalize(f)) return;
  for (int k = 0; k < s; ++k) {
    multiply(f, f, x_);
    f.swap(x_);
    if (!renormalize(f)) return;
  }
}

// f = I + 2 (V − U)⁻¹ U, where U and V are the odd and even parts of the
// Padé numerator, each summed in the old core's order.
void Expm::pade(const Matrix& t, int m, Matrix& f) {
  const Eigen::Index n = t.rows();
  const double* b = m == 3 ? kB3 : m == 5 ? kB5 : m == 7 ? kB7 : m == 9 ? kB9 : kB13;
  u_ = b[1] * Matrix::Identity(n, n);
  v_ = b[0] * Matrix::Identity(n, n);
  if (m == 13) {
    w_ = b[11] * t4_;
    w_ += b[13] * t6_;
    w_ += b[9] * t2_;
    multiply(t6_, w_, x_);
    x_ += b[7] * t6_;
    x_ += b[5] * t4_;
    x_ += b[3] * t2_;
    x_ += u_;
    multiply(t, x_, u_);

    w_ = b[10] * t4_;
    w_ += b[12] * t6_;
    w_ += b[8] * t2_;
    multiply(t6_, w_, x_);
    x_ += b[6] * t6_;
    x_ += b[4] * t4_;
    x_ += b[2] * t2_;
    x_ += v_;
    v_ = x_;
  } else {
    const Matrix* even_powers[] = {&t2_, &t4_, &t6_, &t8_};  // t^(j - 1) for odd j
    for (int j = m; j >= 3; j -= 2) {
      const Matrix& p = *even_powers[(j - 1) / 2 - 1];
      u_ += b[j] * p;
      v_ += b[j - 1] * p;
    }
    multiply(t, u_, x_);
    u_ = x_;
  }

  w_ = 2.0 * u_;
  v_ -= u_;
  // LAPACK inverted the old core's row-major V as Vᵀ; so does this.
  x_ = v_.transpose();
  if (!invert(x_)) {
    f.setConstant(n, n, kNaN);
    return;
  }
  x_.transposeInPlace();
  multiply(x_, w_, f);
  f.diagonal().array() += 1.0;
}

}  // namespace icmm
