/* geng PRUNE plugin: reject any graph that contains a simple cycle of
   length >= 5 (keep graphs whose every simple cycle has length <= 4).

   Build (from a configured nauty 2.9.x source tree, after `make geng`):
     cc -O3 -o geng_c4 -DMAXN=WORDSIZE -DWORDSIZE=32 -DPREPRUNE=c4prune \
         geng.c c4prune.c gtoolsW.o nautyW1.o nautilW1.o naugraphW1.o \
         schreierW.o naurng.o
   -DPRUNE=c4prune also works (same output, about 1.8x slower).
   Then: ./geng_c4 -c -D4 -q N > nN_c4.g6

   scripts/topology_lists.py builds it this way and writes the lists.

   Correctness rests on two facts (proved in docs/research/topology-enumeration.md, on branch
   research/topology-enumeration):
   1. Every cycle lies inside one block (biconnected component), so a graph
      has all cycles <= 4 iff every block has circumference <= 4.
   2. A 2-connected graph on >= 5 vertices has circumference <= 4 iff it is
      K_{2,m} (m >= 3), optionally with the edge joining its two hubs.
      Blocks on <= 4 vertices can hold no cycle longer than 4.
   The property is hereditary (closed under deleting a vertex), so geng may
   prune intermediate graphs: a pruned node has no accepted descendant, and
   the surviving outputs keep their order and labeling.
*/

#include "gtools.h"

static graph *G;
static int dfsnum[WORDSIZE], lowpt[WORDSIZE], counter, bad;
static int su[WORDSIZE * WORDSIZE], sv[WORDSIZE * WORDSIZE], sp;

/* B is the vertex set of one block. The block is the subgraph induced by B
   (an edge between two vertices of a block belongs to that block). */
static int
blockok(setword B)
{
    setword x, H;
    int v, nb;

    nb = POPCOUNT(B);
    if (nb <= 4) return 1;

    /* Hubs = vertices whose degree inside the block is not 2. */
    H = 0;
    x = B;
    while (x)
    {
        TAKEBIT(v, x);
        if (POPCOUNT(G[v] & B) != 2) H |= bit[v];
    }
    if (POPCOUNT(H) != 2) return 0;

    /* Every non-hub must be adjacent to exactly the two hubs. */
    x = B & ~H;
    while (x)
    {
        TAKEBIT(v, x);
        if ((G[v] & B) != H) return 0;
    }
    return 1;
}

/* Hopcroft-Tarjan biconnected components with an edge stack. */
static void
visit(int v, int parent)
{
    setword nbrs;
    int w, a, b;
    setword B;

    dfsnum[v] = lowpt[v] = ++counter;
    nbrs = G[v];
    while (nbrs && !bad)
    {
        TAKEBIT(w, nbrs);
        if (dfsnum[w] == 0)
        {
            su[sp] = v; sv[sp] = w; ++sp;
            visit(w, v);
            if (bad) return;
            if (lowpt[w] < lowpt[v]) lowpt[v] = lowpt[w];
            if (lowpt[w] >= dfsnum[v])
            {
                B = 0;
                do
                {
                    --sp;
                    a = su[sp]; b = sv[sp];
                    B |= bit[a] | bit[b];
                } while (!(a == v && b == w));
                if (!blockok(B)) bad = 1;
            }
        }
        else if (w != parent && dfsnum[w] < dfsnum[v])
        {
            su[sp] = v; sv[sp] = w; ++sp;
            if (dfsnum[w] < lowpt[v]) lowpt[v] = dfsnum[w];
        }
    }
}

/* Nonzero iff g (n vertices, m = 1) has a simple cycle of length >= 5. */
int
has_long_cycle(graph *g, int n)
{
    int v;

    if (n <= 4) return 0;
    G = g;
    counter = 0; bad = 0; sp = 0;
    for (v = 0; v < n; ++v) dfsnum[v] = 0;
    for (v = 0; v < n && !bad; ++v)
        if (dfsnum[v] == 0) visit(v, -1);
    return bad;
}

int
c4prune(graph *g, int n, int maxn)
{
    return has_long_cycle(g, n);
}
