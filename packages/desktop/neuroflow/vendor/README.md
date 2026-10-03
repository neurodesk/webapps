# NeuroFlow schema snapshot

These unmodified NeuroFlow 0.1 schemas come from
[cdrake/neuroflow-spec at 370193d04d061fa7c88b51b25f36cc45510cef4c](https://github.com/cdrake/neuroflow-spec/tree/370193d04d061fa7c88b51b25f36cc45510cef4c/schemas/0.1),
the RFC 0010 branch ([cdrake/neuroflow-spec#1](https://github.com/cdrake/neuroflow-spec/pull/1)).
They add the type qualifiers `formats`, `space`, `resolution`, `density` and
`labelSystem` and the `0.1.1` envelope value a qualified document declares.
Move the commit to the merge commit once that PR lands.
They are used under the included MIT license. Generation and tests validate
against this local snapshot without fetching a schema at runtime.

The launcher follows the script session contract implemented by
[cdrake/neuroflow at cc399f8208473fc429a8cdf04d0ca4ca46547567](https://github.com/cdrake/neuroflow/tree/cc399f8208473fc429a8cdf04d0ca4ca46547567).
That implementation is proposed in [neuroflow#4](https://github.com/cdrake/neuroflow/pull/4).
The earlier envelope-only support does not enforce qualifier constraints.
It uses `core:result-file` and `neuroflow/launch`, and writes absolute artifact
paths to `result.json`. The upstream MCP runtime resolves the launch script
relative to the tool document and requires it to remain inside the registry.

To update this snapshot, copy `common.schema.json`, `events.schema.json`, and
`tool.schema.json`, and `extensions/neuroflow-mcp.schema.json` together, update the commit above and `snapshot.json`, and
run the generator tests. Do not edit the vendored schemas to admit generated
fields. Portable additions belong in an upstream RFC.
