"""Scrambled Sobol' points, for **Sobol start points** (ADR-0008).

scipy's scrambled `scipy.stats.qmc.Sobol` with its defaults: 30 bits, scrambled by a random
lower-triangular matrix and a random digital shift, drawn in scipy's order. Point k drawn from
`rng` is the one `qmc.Sobol(d, rng=r)` gives after `fast_forward(k)` when `rng` is
`r.spawn(1)[0]`, the child scipy draws from. It's written out because scipy was most of what the
engine bundle grew by, and with it Windows CI's install test went from under 8 s to over 60 s
(#46).
`tests/fixtures/sobol` holds scipy's points it reproduces.
"""

from __future__ import annotations

import numpy as np

BITS = 30

DIMENSIONS = 98
"""The most parameters a topology has: 2N + 2E + 2 at 16 states, each of degree 4 (E = 2N)."""


def point(dimensions: int, index: int, rng: np.random.Generator) -> np.ndarray:
    """Point `index`, counted from 0, of the sequence in [0, 1)^`dimensions` that `rng`
    scrambles."""
    if not 1 <= dimensions <= DIMENSIONS:
        raise ValueError(f"Sobol points have 1 to {DIMENSIONS} dimensions, not {dimensions}.")
    if not 0 <= index < 2**BITS:
        raise ValueError(f"A Sobol sequence has 2**{BITS} points, so no point {index}.")
    shifts = rng.integers(2, size=(dimensions, BITS), dtype=np.uint32)
    matrices = rng.integers(2, size=(dimensions, BITS, BITS), dtype=np.uint32)
    gray = index ^ (index >> 1)
    out = []
    for d in range(dimensions):
        x = sum(int(bit) << i for i, bit in enumerate(shifts[d]))
        for j, column in enumerate(_scrambled(_directions(d), matrices[d])):
            if gray >> j & 1:
                x ^= column
        out.append(x)
    return np.array(out) * 2.0**-BITS


def _directions(d: int) -> list[int]:
    """Dimension `d`'s direction numbers, each a column of the generator matrix with its row 0
    as the top bit (Bratley and Fox, 1988)."""
    if d == 0:
        return [1 << (BITS - 1 - j) for j in range(BITS)]
    _, s, a, *v = _JOE_KUO[d - 1]
    poly = 2 * a + 2**s + 1
    for j in range(s, BITS):
        new = v[j - s]
        for k in range(s):
            if poly >> (s - 1 - k) & 1:
                new ^= v[j - k - 1] << (k + 1)
        v.append(new)
    return [m << (BITS - 1 - j) for j, m in enumerate(v)]


def _scrambled(columns: list[int], matrix: np.ndarray) -> list[int]:
    """`columns` times `matrix`'s lower triangle with ones on its diagonal, over GF(2): the
    linear matrix scramble."""
    rows = [
        sum(int(bit) << (BITS - 1 - c) for c, bit in enumerate(matrix[p, :p])) | 1 << (BITS - 1 - p)
        for p in range(BITS)
    ]
    return [
        sum(((row & column).bit_count() & 1) << (BITS - 1 - p) for p, row in enumerate(rows))
        for column in columns
    ]


# Joe and Kuo's direction numbers new-joe-kuo-6.21201, its lines for dimensions 2 to 98, as
# `d s a m_1 ... m_s`; dimension 1 needs none. They are from:
# https://web.maths.unsw.edu.au/~fkuo/sobol/  codespell:ignore maths
#
# Copyright (c) 2008, Frances Y. Kuo and Stephen Joe
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without modification, are permitted
# provided that the following conditions are met:
#
#     * Redistributions of source code must retain the above copyright notice, this list of
#       conditions and the following disclaimer.
#
#     * Redistributions in binary form must reproduce the above copyright notice, this list of
#       conditions and the following disclaimer in the documentation and/or other materials
#       provided with the distribution.
#
#     * Neither the names of the copyright holders nor the names of the University of New South
#       Wales and the University of Waikato and its contributors may be used to endorse or promote
#       products derived from this software without specific prior written permission.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS ``AS IS'' AND ANY EXPRESS OR IMPLIED
# WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS
# FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDERS BE LIABLE FOR
# ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT
# NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR
# BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
# STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
# OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
_JOE_KUO = [
    [int(n) for n in line.split()]
    for line in """\
2 1 0 1
3 2 1 1 3
4 3 1 1 3 1
5 3 2 1 1 1
6 4 1 1 1 3 3
7 4 4 1 3 5 13
8 5 2 1 1 5 5 17
9 5 4 1 1 5 5 5
10 5 7 1 1 7 11 19
11 5 11 1 1 5 1 1
12 5 13 1 1 1 3 11
13 5 14 1 3 5 5 31
14 6 1 1 3 3 9 7 49
15 6 13 1 1 1 15 21 21
16 6 16 1 3 1 13 27 49
17 6 19 1 1 1 15 7 5
18 6 22 1 3 1 15 13 25
19 6 25 1 1 5 5 19 61
20 7 1 1 3 7 11 23 15 103
21 7 4 1 3 7 13 13 15 69
22 7 7 1 1 3 13 7 35 63
23 7 8 1 3 5 9 1 25 53
24 7 14 1 3 1 13 9 35 107
25 7 19 1 3 1 5 27 61 31
26 7 21 1 1 5 11 19 41 61
27 7 28 1 3 5 3 3 13 69
28 7 31 1 1 7 13 1 19 1
29 7 32 1 3 7 5 13 19 59
30 7 37 1 1 3 9 25 29 41
31 7 41 1 3 5 13 23 1 55
32 7 42 1 3 7 3 13 59 17
33 7 50 1 3 1 3 5 53 69
34 7 55 1 1 5 5 23 33 13
35 7 56 1 1 7 7 1 61 123
36 7 59 1 1 7 9 13 61 49
37 7 62 1 3 3 5 3 55 33
38 8 14 1 3 1 15 31 13 49 245
39 8 21 1 3 5 15 31 59 63 97
40 8 22 1 3 1 11 11 11 77 249
41 8 38 1 3 1 11 27 43 71 9
42 8 47 1 1 7 15 21 11 81 45
43 8 49 1 3 7 3 25 31 65 79
44 8 50 1 3 1 1 19 11 3 205
45 8 52 1 1 5 9 19 21 29 157
46 8 56 1 3 7 11 1 33 89 185
47 8 67 1 3 3 3 15 9 79 71
48 8 70 1 3 7 11 15 39 119 27
49 8 84 1 1 3 1 11 31 97 225
50 8 97 1 1 1 3 23 43 57 177
51 8 103 1 3 7 7 17 17 37 71
52 8 115 1 3 1 5 27 63 123 213
53 8 122 1 1 3 5 11 43 53 133
54 9 8 1 3 5 5 29 17 47 173 479
55 9 13 1 3 3 11 3 1 109 9 69
56 9 16 1 1 1 5 17 39 23 5 343
57 9 22 1 3 1 5 25 15 31 103 499
58 9 25 1 1 1 11 11 17 63 105 183
59 9 44 1 1 5 11 9 29 97 231 363
60 9 47 1 1 5 15 19 45 41 7 383
61 9 52 1 3 7 7 31 19 83 137 221
62 9 55 1 1 1 3 23 15 111 223 83
63 9 59 1 1 5 13 31 15 55 25 161
64 9 62 1 1 3 13 25 47 39 87 257
65 9 67 1 1 1 11 21 53 125 249 293
66 9 74 1 1 7 11 11 7 57 79 323
67 9 81 1 1 5 5 17 13 81 3 131
68 9 82 1 1 7 13 23 7 65 251 475
69 9 87 1 3 5 1 9 43 3 149 11
70 9 91 1 1 3 13 31 13 13 255 487
71 9 94 1 3 3 1 5 63 89 91 127
72 9 103 1 1 3 3 1 19 123 127 237
73 9 104 1 1 5 7 23 31 37 243 289
74 9 109 1 1 5 11 17 53 117 183 491
75 9 122 1 1 1 5 1 13 13 209 345
76 9 124 1 1 3 15 1 57 115 7 33
77 9 137 1 3 1 11 7 43 81 207 175
78 9 138 1 3 1 1 15 27 63 255 49
79 9 143 1 3 5 3 27 61 105 171 305
80 9 145 1 1 5 3 1 3 57 249 149
81 9 152 1 1 3 5 5 57 15 13 159
82 9 157 1 1 1 11 7 11 105 141 225
83 9 167 1 3 3 5 27 59 121 101 271
84 9 173 1 3 5 9 11 49 51 59 115
85 9 176 1 1 7 1 23 45 125 71 419
86 9 181 1 1 3 5 23 5 105 109 75
87 9 182 1 1 7 15 7 11 67 121 453
88 9 185 1 3 7 3 9 13 31 27 449
89 9 191 1 3 1 15 19 39 39 89 15
90 9 194 1 1 1 1 1 33 73 145 379
91 9 199 1 3 1 15 15 43 29 13 483
92 9 218 1 1 7 3 19 27 85 131 431
93 9 220 1 3 3 3 5 35 23 195 349
94 9 227 1 3 3 7 9 27 39 59 297
95 9 229 1 1 3 9 11 17 13 241 157
96 9 230 1 3 7 15 25 57 33 189 213
97 9 234 1 1 7 1 9 55 73 83 217
98 9 236 1 3 3 13 19 27 23 113 249
""".splitlines()
]
