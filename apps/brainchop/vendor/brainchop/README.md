Brainchop inference source from neuroneural/brainchop commit
4c87885f3a2a8835e260d521dcec922b58d91d41, under the included MIT license.
The worker awaits both full-volume inference calls and reports rejected inference
promises to its caller. The scientific pipeline is otherwise unchanged. Model weights are
fetched from the same immutable commit, never stored in this repository.
