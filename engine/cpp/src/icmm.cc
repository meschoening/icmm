// The C ABI: every entry point checks its arguments, catches everything, and
// reports failure as a status plus a thread-local message.
#include "icmm.h"

#include <algorithm>
#include <atomic>
#include <exception>
#include <limits>
#include <memory>
#include <mutex>
#include <new>
#include <string>
#include <thread>
#include <vector>

#include "model.hpp"
#include "score.hpp"
#include "session.hpp"

namespace {

thread_local std::string last_error;

int32_t fail(int32_t status, std::string message) {
  last_error = std::move(message);
  return status;
}

template <class F>
int32_t guarded(F&& f) noexcept {
  try {
    return f();
  } catch (const icmm::InvalidArgument& e) {
    return fail(ICMM_INVALID_ARGUMENT, e.message);
  } catch (const std::bad_alloc&) {
    return fail(ICMM_OUT_OF_MEMORY, "out of memory");
  } catch (const std::exception& e) {
    return fail(ICMM_INTERNAL, e.what());
  } catch (...) {
    return fail(ICMM_INTERNAL, "unknown exception");
  }
}

}  // namespace

const char* icmm_version(void) { return ICMM_VERSION_STRING; }

int32_t icmm_abi_version(void) { return ICMM_ABI_VERSION; }

const char* icmm_last_error(void) { return last_error.c_str(); }

int32_t icmm_session_create(const icmm_topology* topology, const icmm_protocol* protocols,
                            int32_t num_protocols, icmm_session** session) {
  return guarded([&]() -> int32_t {
    if (session == nullptr) return fail(ICMM_INVALID_ARGUMENT, "session: it is null.");
    *session = nullptr;
    if (topology == nullptr) return fail(ICMM_INVALID_ARGUMENT, "topology: it is null.");
    if (num_protocols < 1 || protocols == nullptr) {
      return fail(ICMM_INVALID_ARGUMENT, "protocols: a session needs at least one.");
    }
    auto s = std::make_unique<icmm_session>(icmm_session{icmm::copy_topology(*topology), {}});
    s->protocols.reserve(static_cast<size_t>(num_protocols));
    for (int32_t i = 0; i < num_protocols; ++i) {
      s->protocols.push_back(icmm::copy_protocol(protocols[i], i));
    }
    *session = s.release();
    return ICMM_OK;
  });
}

void icmm_session_destroy(icmm_session* session) { delete session; }

int32_t icmm_param_count(const icmm_session* session) {
  return session == nullptr ? 0 : session->topology.param_count();
}

int32_t icmm_score(const icmm_session* session, const double* params, int32_t num_candidates,
                   int32_t num_threads, icmm_protocol_score* scores) {
  return guarded([&]() -> int32_t {
    if (session == nullptr) return fail(ICMM_INVALID_ARGUMENT, "session: it is null.");
    if (num_candidates < 0) {
      return fail(ICMM_INVALID_ARGUMENT, "candidates: there can't be fewer than none.");
    }
    if (num_threads < 1) return fail(ICMM_INVALID_ARGUMENT, "threads: at least one is needed.");
    if (num_candidates == 0) return ICMM_OK;
    if (params == nullptr || scores == nullptr) {
      return fail(ICMM_INVALID_ARGUMENT, "params and scores: neither may be null.");
    }

    const size_t width = static_cast<size_t>(session->topology.param_count());
    const size_t protocols = session->protocols.size();
    std::atomic<int32_t> next{0};
    std::mutex error_lock;
    std::exception_ptr error;
    // Each candidate is scored whole on whichever thread takes it.
    auto work = [&]() noexcept {
      try {
        icmm::Workspace ws(*session);
        for (int32_t c; (c = next.fetch_add(1)) < num_candidates;) {
          const icmm::Model model(session->topology, params + c * width);
          for (size_t k = 0; k < protocols; ++k) {
            scores[c * protocols + k] = icmm::score_protocol(model, session->protocols[k], ws);
          }
        }
      } catch (...) {
        next = num_candidates;
        const std::lock_guard<std::mutex> hold(error_lock);
        if (!error) error = std::current_exception();
      }
    };
    std::vector<std::thread> helpers;
    try {
      // More threads than cores only adds workspaces.
      const int32_t cores = static_cast<int32_t>(std::thread::hardware_concurrency());
      const int32_t threads = std::min({num_threads, num_candidates, cores > 0 ? cores : 1});
      for (int32_t t = 1; t < threads; ++t) helpers.emplace_back(work);
    } catch (...) {
      next = num_candidates;
      for (auto& h : helpers) h.join();
      throw;
    }
    work();
    for (auto& h : helpers) h.join();
    if (error) std::rethrow_exception(error);
    return ICMM_OK;
  });
}

int32_t icmm_point_values(const icmm_session* session, const double* params, double* values,
                          int32_t num_values) {
  return guarded([&]() -> int32_t {
    if (session == nullptr) return fail(ICMM_INVALID_ARGUMENT, "session: it is null.");
    if (params == nullptr || values == nullptr) {
      return fail(ICMM_INVALID_ARGUMENT, "params and values: neither may be null.");
    }
    size_t points = 0;
    for (const icmm::Protocol& p : session->protocols) points += p.x.size();
    if (num_values < 0 || static_cast<size_t>(num_values) != points) {
      return fail(ICMM_INVALID_ARGUMENT, "values: there must be one per point, " +
                                             std::to_string(points) + " in all.");
    }
    icmm::Workspace ws(*session);
    const icmm::Model model(session->topology, params);
    for (const icmm::Protocol& p : session->protocols) {
      icmm::point_values(model, p, ws);
      for (size_t i = 0; i < p.x.size(); ++i) {
        *values++ = ws.failed[i] ? std::numeric_limits<double>::quiet_NaN() : ws.values[i];
      }
    }
    return ICMM_OK;
  });
}

int32_t icmm_simulate(const icmm_session* session, const double* params,
                      icmm_simulation* simulation) {
  return guarded([&]() -> int32_t {
    if (session == nullptr) return fail(ICMM_INVALID_ARGUMENT, "session: it is null.");
    if (params == nullptr || simulation == nullptr) {
      return fail(ICMM_INVALID_ARGUMENT, "params and simulation: neither may be null.");
    }
    icmm_simulation& out = *simulation;
    if (out.values == nullptr || out.scores == nullptr || out.trace_lengths == nullptr ||
        out.trace_time_ms == nullptr || out.trace_open == nullptr) {
      return fail(ICMM_INVALID_ARGUMENT, "simulation: none of its buffers may be null.");
    }
    if (out.max_samples < 1) {
      return fail(ICMM_INVALID_ARGUMENT, "max_samples: a trace keeps at least one moment.");
    }
    size_t points = 0;
    int64_t moments = 0;
    for (const icmm::Protocol& p : session->protocols) {
      for (size_t i = 0; i < p.x.size(); ++i) {
        moments += icmm::trace_length(icmm::recorded_count(p, i), out.max_samples);
      }
      points += p.x.size();
    }
    if (out.num_values < 0 || static_cast<size_t>(out.num_values) != points) {
      return fail(ICMM_INVALID_ARGUMENT, "values: there must be one per point, " +
                                             std::to_string(points) + " in all.");
    }
    if (out.trace_capacity < moments) {
      return fail(ICMM_INVALID_ARGUMENT, "traces: they need room for " + std::to_string(moments) +
                                             " moments.");
    }
    icmm::Workspace ws(*session);
    const icmm::Model model(session->topology, params);
    icmm::TraceSink sink{out.max_samples, out.trace_lengths, out.trace_time_ms, out.trace_open};
    double* values = out.values;
    icmm_protocol_score* scores = out.scores;
    for (const icmm::Protocol& p : session->protocols) {
      icmm::point_values(model, p, ws, &sink);
      for (size_t i = 0; i < p.x.size(); ++i) {
        *values++ = ws.failed[i] ? std::numeric_limits<double>::quiet_NaN() : ws.values[i];
      }
      *scores++ = icmm::score_values(p, ws);
    }
    return ICMM_OK;
  });
}
