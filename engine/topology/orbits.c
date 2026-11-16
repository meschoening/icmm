/* Each graph's vertex orbits, for the topology lists (scripts/topology_lists.py).

   Reads graph6 on stdin. For each graph on n <= 16 vertices it writes ceil(n/2) bytes to stdout:
   vertex v's orbit's lowest vertex in nibble v, low nibble first, and 0 in the last high nibble
   when n is odd. nauty names each orbit by its least vertex (orbits[v]), so a vertex is an open
   state of its graph iff its nibble is its own number (ADR-0018).

   Build (from a configured nauty 2.9.x source tree, after `make geng`):
     cc -O2 -o orbits -DMAXN=WORDSIZE -DWORDSIZE=32 orbits.c \
         gtoolsW.o nautyW1.o nautilW1.o naugraphW1.o schreierW.o naurng.o
*/

#include "gtools.h"

int
main(void)
{
    graph g[MAXN];
    int lab[MAXN], ptn[MAXN], orbits[MAXN];
    unsigned char record[8];
    statsblk stats;
    int m, n, v;
    DEFAULTOPTIONS_GRAPH(options);

    while (readg(stdin, g, 1, &m, &n) != NULL)
    {
        if (n > 16) gt_abort(">E orbits: a graph has more than 16 vertices\n");
        densenauty(g, lab, ptn, orbits, &options, &stats, m, n, NULL);
        memset(record, 0, sizeof record);
        for (v = 0; v < n; ++v)
            record[v / 2] |= (unsigned char)(orbits[v] << (4 * (v % 2)));
        if (fwrite(record, 1, (n + 1) / 2, stdout) != (size_t)((n + 1) / 2)) return 1;
    }
    return fflush(stdout) == 0 ? 0 : 1;
}
