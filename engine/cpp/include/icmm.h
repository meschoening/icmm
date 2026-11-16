/* The C ABI of libicmm. Every exported function is declared here and marked
 * ICMM_EXPORT; nothing else leaves the library.
 *
 * A session holds one topology and one dataset's protocols, copied in when it
 * is created; scoring reads it and never changes it, so any number of threads
 * may score against one session at once. Every entry point returns a status
 * and never throws; after a status other than ICMM_OK, icmm_last_error()
 * says why, on the calling thread. icmm.core (Python) mirrors these types. */
#ifndef ICMM_H
#define ICMM_H

#include <stdint.h>

#include "icmm_export.h"

#ifdef __cplusplus
extern "C" {
#endif

/* The version of this ABI's types and functions; icmm.core refuses a library
 * built for another. Bump it with any change to them. */
#define ICMM_ABI_VERSION 3

/* The most states a topology may have. */
#define ICMM_MAX_STATES 16

/* The most moments a measured step may record in one sweep. */
#define ICMM_MAX_RECORDED 1000000

enum {
  ICMM_OK = 0,
  ICMM_INVALID_ARGUMENT = 1,
  ICMM_OUT_OF_MEMORY = 2,
  ICMM_INTERNAL = 3,
};

/* Which quantity of the swept step takes each point's x (icmm.dataset.SweptQuantity). */
enum { ICMM_SWEPT_VOLTAGE = 0, ICMM_SWEPT_DURATION = 1 };

/* What the measured step reports (icmm.dataset.MeasureCode). */
enum { ICMM_MEASURE_PEAK = 1, ICMM_MEASURE_DECAY_TIME = 2, ICMM_MEASURE_TIME_TO_PEAK = 3 };

/* A state graph. Edge i joins states edges[2i] and edges[2i + 1]; the edge
 * order is the order of the edge parameters. */
typedef struct icmm_topology {
  int32_t num_states;
  int32_t num_edges;
  const int32_t* edges;
  int32_t open_state;
} icmm_topology;

/* One protocol, as icmm.dataset.core_arrays builds it. */
typedef struct icmm_protocol {
  double holding_mV;
  int32_t num_steps;
  const double* step_voltage_mV;  /* num_steps values; NaN at the swept voltage */
  const double* step_duration_ms; /* num_steps values; NaN at the swept duration */
  int32_t swept_step;
  int32_t swept_quantity;
  int32_t measured_step;
  int32_t measure;
  double decay_from; /* fractions of the peak; read only for a decay time */
  double decay_to;
  double time_resolution_ms;
  int32_t normalized;
  int32_t num_points;
  const double* x;             /* num_points values */
  const double* value;         /* num_points values */
  const uint8_t* validation;   /* num_points values: 1 for a validation point */
} icmm_protocol;

/* One protocol's score for one parameter vector: the summed squared error over
 * its train points and over its validation points, unweighted, with how many
 * points each has and how many of them failed. A failed point's sweep didn't
 * simulate to a finite value, or had nothing to be normalized by; it adds
 * nothing to the sum. */
typedef struct icmm_protocol_score {
  double train_sse;
  double val_sse;
  int32_t train_points;
  int32_t train_failed;
  int32_t val_points;
  int32_t val_failed;
} icmm_protocol_score;

typedef struct icmm_session icmm_session;

/* The library's version, e.g. "0.1.0". The string is static; don't free it. */
ICMM_EXPORT const char* icmm_version(void);

/* ICMM_ABI_VERSION, as the library was built. */
ICMM_EXPORT int32_t icmm_abi_version(void);

/* Why the calling thread's last call failed. Valid until its next call. */
ICMM_EXPORT const char* icmm_last_error(void);

/* Checks and copies a topology and its protocols into a new session. */
ICMM_EXPORT int32_t icmm_session_create(const icmm_topology* topology,
                                        const icmm_protocol* protocols, int32_t num_protocols,
                                        icmm_session** session);

/* Frees a session; null is ignored. */
ICMM_EXPORT void icmm_session_destroy(icmm_session* session);

/* A parameter vector's length: 2 per state, 2 per edge, then the sigmoid's a
 * and b (mV). */
ICMM_EXPORT int32_t icmm_param_count(const icmm_session* session);

/* Scores num_candidates parameter vectors, stored one after another in params,
 * on up to num_threads threads. Writes num_protocols scores per candidate to
 * scores, candidate by candidate. Each candidate is scored on one thread, so
 * the thread count never changes a score. */
ICMM_EXPORT int32_t icmm_score(const icmm_session* session, const double* params,
                               int32_t num_candidates, int32_t num_threads,
                               icmm_protocol_score* scores);

/* Writes each point's model value for one parameter vector: protocol by
 * protocol in the session's order, and point by point in each protocol's
 * order, so num_values must be as many as the session's protocols have
 * points. A value is what the point's score compares with its data (a peak,
 * or a decay time or time to peak in ms), divided as its protocol is
 * normalized; a failed point's value is NaN. */
ICMM_EXPORT int32_t icmm_point_values(const icmm_session* session, const double* params,
                                      double* values, int32_t num_values);

/* One parameter vector simulated whole, for drawing it: each point's value
 * and each protocol's score exactly as icmm_point_values and icmm_score give
 * them, and each point's sweep as its measured step's open probability over
 * time. A sweep's trace is the moments its measure reads (the step's first,
 * then one each time resolution to its end, the last interval shorter when the
 * duration isn't a whole number of them), thinned to at most max_samples
 * evenly strided moments plus the last: with n moments and n - 1 >
 * max_samples, every ceil((n - 1) / max_samples)-th from the first, then the
 * step's end. Times are in ms from the measured step's start. A failed sweep's
 * trace holds whatever its simulation gave, NaN or infinite included.
 *
 * The caller owns every buffer. values and trace_lengths hold num_values
 * entries, one per point, protocol by protocol in the session's order, and
 * scores one per protocol. The traces are written one after another into
 * trace_time_ms and trace_open, trace_lengths[i] moments for point i, which
 * must hold all of them: num_values * (max_samples + 1) always does. */
typedef struct icmm_simulation {
  double* values;
  int32_t num_values;
  icmm_protocol_score* scores;
  int32_t max_samples; /* at least 1 */
  int32_t* trace_lengths;
  double* trace_time_ms;
  double* trace_open;
  int64_t trace_capacity;
} icmm_simulation;

ICMM_EXPORT int32_t icmm_simulate(const icmm_session* session, const double* params,
                                  icmm_simulation* simulation);

#ifdef __cplusplus
}
#endif

#endif /* ICMM_H */
