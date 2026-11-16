#include "inverse.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <utility>

namespace icmm {

namespace {

// Column-major storage with leading dimension ld, 0-based: x(i, j) = x[i + j * ld].
using Pivots = std::array<int, ICMM_MAX_STATES>;

// dlaswp: swaps rows k and pivots[k] of an n-column block, for k in [k1, k2).
void swap_rows(int n, double* a, int ld, int k1, int k2, const int* pivots) {
  for (int k = k1; k < k2; ++k) {
    const int p = pivots[k];
    if (p == k) continue;
    for (int j = 0; j < n; ++j) std::swap(a[k + j * ld], a[p + j * ld]);
  }
}

// dtrsm('L', 'L', 'N', 'U'): b = l⁻¹ b, l unit lower triangular (m × m), b m × n.
void solve_unit_lower(int m, int n, const double* l, int ldl, double* b, int ldb) {
  for (int j = 0; j < n; ++j) {
    for (int k = 0; k < m; ++k) {
      const double bkj = b[k + j * ldb];
      if (bkj == 0) continue;
      for (int i = k + 1; i < m; ++i) b[i + j * ldb] = b[i + j * ldb] - bkj * l[i + k * ldl];
    }
  }
}

// dgemm('N', 'N') with alpha −1 and beta 1: c = c − a b; a m × k, b k × n.
void subtract_product(int m, int n, int k, const double* a, int lda, const double* b, int ldb,
                      double* c, int ldc) {
  for (int j = 0; j < n; ++j) {
    for (int l = 0; l < k; ++l) {
      const double t = -b[l + j * ldb];
      for (int i = 0; i < m; ++i) c[i + j * ldc] = c[i + j * ldc] + t * a[i + l * lda];
    }
  }
}

// dgetrf2: recursive LU with partial pivoting of the m × n block a. Returns
// LAPACK's info: 0, or 1 + the first zero pivot's index.
int factor(int m, int n, double* a, int ld, int* pivots) {
  if (m == 0 || n == 0) return 0;
  if (m == 1) {
    pivots[0] = 0;
    return a[0] == 0 ? 1 : 0;
  }
  if (n == 1) {
    int p = 0;  // idamax
    double largest = std::fabs(a[0]);
    for (int i = 1; i < m; ++i) {
      if (std::fabs(a[i]) > largest) {
        p = i;
        largest = std::fabs(a[i]);
      }
    }
    pivots[0] = p;
    if (a[p] == 0) return 1;
    if (p != 0) std::swap(a[0], a[p]);
    if (std::fabs(a[0]) >= std::numeric_limits<double>::min()) {
      const double r = 1 / a[0];
      for (int i = 1; i < m; ++i) a[i] = r * a[i];
    } else {
      for (int i = 1; i < m; ++i) a[i] = a[i] / a[0];
    }
    return 0;
  }
  const int n1 = std::min(m, n) / 2;
  const int n2 = n - n1;
  int info = factor(m, n1, a, ld, pivots);
  double* a12 = a + n1 * ld;
  double* a21 = a + n1;
  double* a22 = a + n1 + n1 * ld;
  swap_rows(n2, a12, ld, 0, n1, pivots);
  solve_unit_lower(n1, n2, a, ld, a12, ld);
  subtract_product(m - n1, n2, n1, a21, ld, a12, ld, a22, ld);
  const int info2 = factor(m - n1, n2, a22, ld, pivots + n1);
  if (info == 0 && info2 > 0) info = info2 + n1;
  for (int i = n1; i < std::min(m, n); ++i) pivots[i] += n1;
  swap_rows(n1, a, ld, n1, std::min(m, n), pivots);
  return info;
}

// dtrti2('U', 'N'): u = u⁻¹ for the upper triangle, which has no zero on its diagonal.
void invert_upper(int n, double* u, int ld) {
  for (int j = 0; j < n; ++j) {
    u[j + j * ld] = 1 / u[j + j * ld];
    const double ajj = -u[j + j * ld];
    double* x = u + j * ld;  // dtrmv('U', 'N', 'N', j): x = u x over the leading j × j
    for (int jj = 0; jj < j; ++jj) {
      if (x[jj] == 0) continue;
      const double t = x[jj];
      for (int i = 0; i < jj; ++i) x[i] = x[i] + t * u[i + jj * ld];
      x[jj] = x[jj] * u[jj + jj * ld];
    }
    for (int i = 0; i < j; ++i) x[i] = ajj * x[i];
  }
}

}  // namespace

bool invert(Matrix& matrix) {
  const int n = static_cast<int>(matrix.rows());
  const int ld = static_cast<int>(matrix.outerStride());
  double* a = matrix.data();
  Pivots pivots{};
  if (factor(n, n, a, ld, pivots.data()) != 0) return false;

  // dgetri, unblocked: inv(u), then solve inv(a) l = inv(u) column by column.
  invert_upper(n, a, ld);
  std::array<double, ICMM_MAX_STATES> work{};
  for (int j = n - 1; j >= 0; --j) {
    for (int i = j + 1; i < n; ++i) {
      work[i] = a[i + j * ld];
      a[i + j * ld] = 0;
    }
    // dgemv('N'): a(:, j) = a(:, j) − a(:, j+1:n) work(j+1:n)
    for (int jj = j + 1; jj < n; ++jj) {
      const double t = -work[jj];
      for (int i = 0; i < n; ++i) a[i + j * ld] = a[i + j * ld] + t * a[i + jj * ld];
    }
  }
  for (int j = n - 2; j >= 0; --j) {
    const int p = pivots[j];
    if (p != j) {
      for (int i = 0; i < n; ++i) std::swap(a[i + j * ld], a[i + p * ld]);
    }
  }
  return true;
}

}  // namespace icmm
