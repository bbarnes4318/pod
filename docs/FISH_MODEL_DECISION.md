# Fish scene model decision

As of July 28, 2026, Fish Audio's official materials identify `s2.1-pro-free` as the S2.1 Pro model exposed through a free API model string. Fish states that the free tier uses the same model weights and infrastructure as its paid offering; the published differences are service terms such as SLA, latency guarantees, data retention, availability window, and commercial-use conditions—not synthesized-audio quality.

Production therefore does not infer quality from whether a Fish model string is paid or free. `FISH_SCENE_MODEL` is operator-configurable and defaults to `s2.1-pro-free` while that model remains available. Every rendered scene must still pass the application's independent raw-audio performance QA before it can be selected or published.

Revisit this decision when Fish changes model availability or publishes controlled evidence that a different model produces better podcast dialogue for this workload.
