// A matrix inverse that rounds like reference LAPACK 3.11: dgetrf (which
// hands matrices this small to the recursive dgetrf2) then dgetri, with the
// reference BLAS kernels they call. The goldens were frozen from that build,
// and the matrix exponential's Padé step inverts through it, so matching its
// rounding keeps the port on the same side of the old measures' knife edges.
#ifndef ICMM_INVERSE_HPP
#define ICMM_INVERSE_HPP

#include "linalg.hpp"

namespace icmm {

// a = a⁻¹, factored as LAPACK factors the matrix it's handed. Returns false,
// leaving a undefined, if a is singular (an exactly zero pivot).
bool invert(Matrix& a);

}  // namespace icmm

#endif  // ICMM_INVERSE_HPP
