# NeuroFlow schema snapshot

These unmodified NeuroFlow 0.1 schemas come from
[cdrake/neuroflow-spec at 40ed9ce02184183237613318db48286b9f4c504f](https://github.com/cdrake/neuroflow-spec/tree/40ed9ce02184183237613318db48286b9f4c504f/schemas/0.1),
the merged RFC 0010 change ([cdrake/neuroflow-spec#1](https://github.com/cdrake/neuroflow-spec/pull/1)).
They add the type qualifiers `formats`, `space`, `resolution`, `density` and
`labelSystem` and the `0.1.1` envelope value a qualified document declares.
They are used under the included MIT license. Generation and tests validate
against this local snapshot without fetching a schema at runtime.

The launcher follows the script session contract implemented by
[cdrake/neuroflow at cc399f8208473fc429a8cdf04d0ca4ca46547567](https://github.com/cdrake/neuroflow/tree/cc399f8208473fc429a8cdf04d0ca4ca46547567).
That implementation was merged in [neuroflow#4](https://github.com/cdrake/neuroflow/pull/4).
The earlier envelope-only support does not enforce qualifier constraints.
It uses `core:result-file` and `neuroflow/launch`, and writes absolute artifact
paths to `result.json`. The upstream MCP runtime resolves the launch script
relative to the tool document and requires it to remain inside the registry.

To update this snapshot, copy `common.schema.json`, `events.schema.json`, and
`tool.schema.json`, and `extensions/neuroflow-mcp.schema.json` together, update the commit above and `snapshot.json`, and
run the generator tests. Do not edit the vendored schemas to admit generated
fields. Portable additions belong in an upstream RFC.
