# ADR-0004: Run cryo-EM processing on HPC through the compute server

- Status: accepted
- Date: 2026-11-07

## Context

Microscopy users ask for CryoSPARC in the microscopy catalogue. Single-particle
cryo-EM processing (motion correction, CTF estimation, particle picking, 2D
classification, initial model, 3D refinement) runs for hours on GPU nodes and
reads hundreds of gigabytes to several terabytes of movies. It does not fit in a
browser.

[ADR-0003](0003-remote-compute-nodes.md) lets a webapp send jobs to a
user-operated `neurodesk-compute` server. Five of its assumptions do not hold
for cryo-EM:

1. **Licence.** CryoSPARC is proprietary. Each lab needs a licence ID from
   Structura Biotechnology and installs it itself, so it cannot be a pinned
   Neurodesk container.
2. **Data size.** Protocol v1 uploads inputs from the browser
   (`maxUploadBytes` 4 GB, `maxFiles` 40). Cryo-EM data already sits on facility
   or HPC storage.
3. **Scheduling.** The runners (`docker`, `apptainer`, `native`, `simulate`) run
   the tool on the server's host. On an HPC that is a login or submit node.
   Jobs must go through Slurm, and they outlive the server process.
4. **Job layout.** Each v1 job has its own `in/` and `out/`. RELION works in one
   project directory: every job writes `<Type>/jobNNN/`, and STAR files name
   files of earlier jobs by project-relative paths
   (`particles.star` → `Extract/job007/…mrcs` → `MotionCorr/job002/…mrc`).
5. **Lifetime and identity.** v1 owners are per pairing (`auth.rs`
   `Sessions::pair` mints a new owner each time) and finished jobs are swept
   after one hour (`main.rs`). A cryo-EM project spans days and many browser
   sessions.

## Decision

Build the cryo-EM app on RELION, run by the compute server on Slurm. The server
gains a single-owner mode and, in that mode only, server-side data roots, RELION
projects and a Slurm runner. CryoSPARC is neither run nor wrapped.

### Alternatives considered

- **CryoSPARC, or a front end to a lab's own CryoSPARC.** Not redistributable;
  CryoSPARC already has a web interface, so a front end adds little.
- **RELION's own GUI in an Open OnDemand remote desktop.** Works today where a
  site offers it. The app adds a browser workspace without a remote desktop,
  the catalogue's interface, result viewing in the page, and the same server for
  sites without Open OnDemand. If no site needs that, this ADR should be
  rejected in favour of documenting the remote-desktop route.
- **One job for the whole pipeline.** Rejected: class selection is a human
  decision between steps, and a failed step must rerun alone.
- **Isolated per-job directories with mounted predecessors.** Rejected: RELION's
  transitive project-relative paths do not survive it (Context 4).

### Scientific scope

- The Neurodesk `relion` container (neurocontainers `recipes/relion`): RELION
  5.1.1 (GPLv2) built for CUDA compute capabilities 7.0 to 9.0 with compute_90
  PTX, CTFFIND 4.1.14 and RELION's pinned Python environment. The image also
  ships MotionCor2 and Topaz for desktop use; the first release calls neither,
  because Laplacian-of-Gaussian picking and RELION's own motion correction
  cover it.
- RELION 5's Blush and class-ranker weights are baked into the image. Compute
  nodes are often offline and AGENTS.md requires immutable sources.
- CTFFIND 4.1.14's `COPYING` is the Janelia Research Campus Software License
  1.2, which permits redistribution in source and binary form.
- Commands of the `relion` tool, one per job: `import`, `motioncorr`,
  `ctffind`, `autopick` (LoG), `extract`, `class2d`, `select`, `initialmodel`,
  `refine3d`, `maskcreate`, `postprocess`. `select` writes the particles of the
  chosen classes, either the class numbers the user picked in the app or
  RELION's class ranker above a score threshold. The exact command is fixed in
  the protocol document. CTF refinement, polishing and 3D classification are not
  in the first release.
- **Validation.** The RELION 3.0 tutorial subset of EMPIAR-10204
  (beta-galactosidase), the data RELION 5's tutorial uses, pinned on the
  Hugging Face dataset after checking its licence. The endpoint is PostProcess
  after the first Refine3D. The reference is RELION run through its own GUI from
  the same container on the same inputs and settings, recorded in
  `validation/relion-reference.json` together with the acceptance tolerances
  before the app's first validation run. Three gates:
  1. **Arguments.** Per command except `select`, the generated argv equals the
     command RELION's GUI writes to `note.txt` for the same settings and the same
     fixed resource profile, after removing the MPI launcher and normalising
     `jobNNN` numbers. The GUI's manual selection is interactive
     (`relion_display`), so `select` has no GUI command to compare.
  2. **Front end.** Import through Extract gives the reference's micrograph and
     particle counts exactly. The reference is recorded twice; a step whose two
     reference runs differ is compared within a recorded tolerance instead.
  3. **Reconstruction.** GPU RELION is not bitwise reproducible, so the app's own
     Class2D run is selected by the class ranker at the reference's threshold.
     The PostProcess gold-standard resolution must lie within the recorded
     tolerance of the reference, with a valid phase-randomised FSC.

### Projects

Projects exist only in single-owner mode. A project is one RELION project
directory owned by the server: `<data-dir>/projects/<project id>/`.

- Endpoints: create, list, read (its jobs and their dependencies), and delete.
  Delete returns 409 while any job in the project is active or its submission
  is unresolved.
- A `relion` job names its project. The server assigns `<Type>/jobNNN/`; files
  uploaded for the job (gain reference, mask) are stored inside that directory,
  so STAR files refer to them by project-relative paths.
- An input from an earlier job is a project-relative path
  (`"Extract/job007/particles.star"`). It must be a declared output of a
  succeeded job in the same project. The server records that job as a direct
  dependency.
- Projects are not swept by retention. A job can be deleted only when it is
  terminal, its submission is resolved, and no other job depends on it. Since
  every dependency is direct, deleting a chain goes from the newest job back,
  and no surviving job loses a file its STAR files reference. Dependency checks
  and job creation happen under the job store's lock and are persisted in the
  job record.
- The server does not write RELION's `default_pipeline.star`. That needs RELION's
  pipeliner, and opening the project in RELION's GUI is not a first-release
  goal. The dependency graph lives in the server's job records.
- Inside the container the project is mounted read-write at `/project`, which is
  the working directory, and data roots are mounted read-only at
  `/data/<root>`. Both paths are the same for every job, so paths RELION writes
  stay valid in later jobs. STAR files store `/data/<root>` paths, so renaming or
  removing a root, or a site purge of scratch storage, breaks existing projects;
  the operator text says so.

### Data roots

- The operator configures named read-only roots
  (`--data-root facility=/scratch/cryoem/incoming`).
- Listing a root or a directory in it requires a token, is paged, and never
  returns host paths.
- `import` takes `{ "root": "facility", "path": "2026-11/grid3", "pattern":
  "*.tiff" }`. `path` is relative and normalised; `..`, absolute paths and NUL
  are rejected. `pattern` allows `*` and `?` within one name and no `/`. The
  server canonicalises the directory and every match, rejects any outside the
  canonical root, and refuses an empty match.
- That check gives early errors and protects the listing endpoint. The security
  boundary is the container's mount set. The batch script starts `apptainer`,
  by the absolute path the operator configured, through `env -i` with an
  allowlist (`PATH`, `HOME`, `USER`, `LANG`, `CUDA_VISIBLE_DEVICES`), so no
  `APPTAINER_*` or `SINGULARITY_*` variable a site module exports can add a
  mount. It runs `apptainer exec --containall --no-mount hostfs,bind-paths
  --workdir <node-local scratch>`. The container then sees `/project`,
  `/data/<root>`, the image, and with `--nv` the host's GPU driver libraries and
  devices. A symlink created after submission, or a path inside a STAR file,
  cannot reach anything else. Data roots may change between submission and the
  job starting; the job sees them as they are when it runs.

### Single-owner mode

The Slurm runner requires `--single-owner`. Every pairing then maps to one owner,
the Unix user the server runs as, so a user who pairs again next day sees their
projects. Sessions are keyed by credential, separately from the owner:
`DELETE /api/v1/session` revokes only the calling credential. Today both servers
revoke by owner, so this changes `Sessions::revoke` and the reference server.
Credentials in this mode expire after a period of inactivity that the protocol
document sets, because each one grants access to every project. The server
refuses `--token` on its command line in this mode, because other users of a
login node can read it with `ps`, and reads the pairing code from a mode 0600
file. Clinic deployments keep per-pairing owners and have no projects or data
roots.

### Protocol changes

`protocol` stays `1`. Clients that do not use the new features see no change.

- `GET /api/v1/info` with a token adds `features` (`["projects", "dataRoots",
  "scheduler"]`), `dataRoots` (id and label) and `profiles` (name and summary).
  Without a token it is unchanged.
- New tools, endpoints and fields only. NeSVoR and SCT jobs keep their shape.
- Status values do not change. A job the server is submitting, or that Slurm
  holds, is `queued` with `position: 0`. `message` carries Slurm's pending
  reason. Jobs gain `scheduler: { "id": "123456", "state": "PENDING" }`, `null`
  until Slurm has accepted the job and for local runners.
- `relion` outputs are listed after the job ends, as project-relative paths
  inside that job's own `<Type>/jobNNN/`. Files above the server's download
  limit carry `"download": false`; they stay on the cluster and remain usable as
  inputs. `GET /jobs/{id}/outputs/{path}` accepts `/` in the path and resolves it
  by canonicalising it and requiring the result to lie inside the job's own
  directory, since RELION can create symlinks there. This needs
  dynamic outputs in place of the static `Tool::outputs()` list.
- File uploads become tool-specific: `relion` accepts an MRC gain reference and
  an MRC mask. Both servers currently accept or rename only NIfTI.
- `limits` gains `maxDownloadBytes`.
- A spec may name a resource `profile`; each command has an operator default.
  The caller never passes Slurm flags.

### Job lifecycle on Slurm

The runner reports state to the job store through a status channel, not only a
final outcome. The job store stops marking a job running before the runner
starts it. Polling intervals, retry windows and grace periods are set in the
protocol document.

| Internal state | Wire status | Meaning |
| --- | --- | --- |
| `waiting` | `queued` | In the server's own queue, not yet handed to Slurm |
| `submitting` | `queued` | `sbatch` called or about to be; acceptance not yet known |
| `pending` | `queued` + scheduler id | Accepted by Slurm, waiting |
| `running` | `running` | Slurm reports `RUNNING` |
| `cancelling` | `cancelling` | Cancel requested; termination not yet confirmed |
| `succeeded`, `failed`, `cancelled` | same | Terminal |

- **Submission.** The runner writes `job.sbatch`, then persists `submitting`
  with the submission time before calling `sbatch`. The Slurm job name is
  `nd-<job id>`, unique per job. After `sbatch` returns, it persists the Slurm
  ID.
- **Reconciliation.** A `submitting` job (after a crash, or when `sbatch`'s
  answer was lost) is looked up by name for the server's user, with
  `squeue --me --name` and `sacct -u <user> --name`, with `-S` set a margin
  before the recorded submission time to allow for clock skew.
  If found, the runner adopts it. Empty answers are not proof of absence while
  accounting may lag: the job stays `submitting` until both have been empty for
  the protocol's retry window, and then fails as `interrupted`. The server never
  resubmits on its own.
- **Restart.** Jobs with a Slurm ID re-attach: polling resumes and the log is
  re-read from the start of the Slurm output file, the only copy of the log.
  Re-attached and unresolved jobs count toward `--parallel`, which caps jobs
  handed to Slurm.
- **Shutdown** detaches from Slurm jobs; it does not cancel them.
- **Cancel.** A `waiting` job is cancelled at once, as in v1. A `submitting`
  job persists the cancel request, becomes `cancelling`, and after
  reconciliation either `scancel`s the adopted job or, if none exists, becomes
  `cancelled`. A `pending` or `running` job gets `scancel` and stays
  `cancelling` until accounting reports a terminal state. It cannot be deleted
  before then, so no new job can reuse a directory a Slurm job still writes.
- **Polling.** One `squeue --me` call per interval for all active jobs. Once a
  job leaves `squeue`, `sacct -X` (allocation record only, not `.batch` or
  `.extern`) gives the state and `exit:signal`. While `sacct` has no record
  yet, the runner falls back to `scontrol show job`. If neither knows the job
  for the retry window, it fails as `scheduler-lost`. Polling errors leave the
  state unchanged and are logged. Persistent failures make new submissions
  return `runner-unavailable`.

| Slurm terminal state | Result |
| --- | --- |
| `COMPLETED`, exit 0, `RELION_JOB_EXIT_SUCCESS` present | `succeeded` |
| `COMPLETED` with `RELION_JOB_EXIT_FAILURE`, or no marker within the grace period | `failed` |
| `CANCELLED` after a user cancel | `cancelled` |
| `CANCELLED` otherwise (administrator), `FAILED`, `TIMEOUT`, `OUT_OF_MEMORY`, `NODE_FAIL`, `PREEMPTED`, `BOOT_FAIL`, `DEADLINE`, any other state | `failed`, with the state and exit code in `error.message` |

- Jobs are submitted with `--no-requeue`, so a node failure cannot rerun the
  script into a used job directory.
- RELION runs with `--pipeline_control`, so it writes
  `RELION_JOB_EXIT_SUCCESS` or `RELION_JOB_EXIT_FAILURE`. After `COMPLETED`,
  the server waits up to a bounded grace period for one of them, because the
  login node's NFS cache can lag behind the compute node. Outputs are read only
  after it appears.
- **Single instance.** Today the server holds `flock` on `server.lock`
  (`server.rs`), which some Lustre and NFS mounts do not honour across hosts. In
  Slurm mode the server also creates a lock file exclusively (`O_EXCL`), holding
  host, PID and process start time, and keeps the `flock` as a second guard. An
  existing lock file always makes the server refuse to start and name the
  holder, even when that process looks dead. `neurodesk-compute unlock` removes
  it once the operator has confirmed the old server is stopped, and refuses
  while the `flock` is still held. There is no
  automatic takeover, so two servers starting at once, or a paused server
  resuming, cannot both write the data directory.
- **Startup checks.** `sbatch`, `squeue`, `sacct`, `scontrol` and `scancel` must
  run, accounting must answer, and `sbatch --test-only` must accept each
  profile. Sites without Slurm accounting are not supported in the first
  release.
- **Compute-node check.** `neurodesk-compute check-slurm --profile <name>`
  submits a short job through the same script template. It confirms that the
  node can read the image and every data root, can write the projects
  directory and `/tmp`, and sees the allocated GPUs. It runs with
  `APPTAINER_BIND`, `APPTAINER_MOUNT` and `SINGULARITY_BIND` set to an outside
  directory and confirms the container cannot read it or any other host path
  outside the mount set. Operators run it once per profile before use; the install text
  says so.

### Launching RELION on one node

Each command has a launch plan in the tool definition. Argv depends on the spec
and the profile.

- MPI commands (`motioncorr`, `ctffind`, `autopick`, `extract`, `refine3d`)
  run `mpirun --bind-to none -np <ranks>` from the container's OpenMPI, on one
  node, inside one `apptainer exec`. `refine3d` uses the smallest odd rank count
  that is at least 3 and at least GPUs + 1. A profile that cannot satisfy that
  is refused for `refine3d` at startup.
- `class2d` (VDAM) and `initialmodel` run one process; RELION does not support
  MPI for them.
- `--j` is the profile's CPUs divided by the rank count. `--gpu` is
  set from the profile's GPUs.
- `--containall` clears the environment, so the script passes
  `CUDA_VISIBLE_DEVICES` into the container explicitly. Otherwise, on nodes
  without device cgroups, RELION would use GPUs Slurm did not allocate.
- Multi-node MPI is out of scope.

### Images

- The tool definition pins the container's Docker digest in the four places
  AGENTS.md lists for compute tools: the design document,
  `registry/neurocontainers.json`, the Rust tool definition and the reference
  server.
- The SIF built from that digest is published once to the Hugging Face dataset
  and pinned by SHA-256. Rebuilding a SIF does not reproduce its bytes, and
  Neurocontainers deletes rebuilt `.simg` files.
- The operator gives the SIF path. The server checks the SHA-256 once and caches
  the result by path, size and modification time. CVMFS sandboxes are not
  supported in the first release.

### Deployment

- One instance per user, as that user, on a host allowed to submit jobs, kept
  alive with `tmux` or a user systemd unit. Never root, never a shared service
  account. A login alias often covers several hosts and some sites stop
  long-running user processes; the install text says to start the server on a
  named host where that is allowed.
- In Slurm mode the server binds to `127.0.0.1` on a port the user chooses; two
  users on one login node cannot share a port. Other local users can reach a
  loopback port, so the pairing code file is mode 0600 and every API call needs
  a bearer token.
- **The only supported route for the first release:** an SSH tunnel to that
  named host and port, with the server serving the built app itself (`--www`)
  at `http://localhost:<port>`. The page and API share one origin, and
  `localhost` is a secure context. The hosted microscopy page, Open OnDemand and
  site gateways are deferred.

### Repository contracts

- The app's `execution` override in `registry/app-information.yml` and its
  Privacy template state that data stays on the cluster and only the listed
  result files reach the browser.
- **Working example.** `neurodesk-compute fetch-example relion-tutorial`
  downloads the pinned tutorial subset into an `examples` data root. The app
  offers it in its input section when the server lists that root. The browser
  test drives it against the Node reference server's simulated `relion` tool
  through to a downloaded map.

### Testing

- Both servers implement single-owner mode, projects and data roots with a
  simulated `relion` tool. It writes real STAR files that reference earlier jobs'
  files, so a chain from extraction to refinement is checked through actual
  references. It is always labelled simulated.
- `test/remote-compute-protocol.test.mjs` adds:
  - path-escape cases (`..`, absolute, `/` in a pattern, a symlinked match out of
    the root);
  - output path containment;
  - dependency and deletion rules;
  - two credentials sharing one owner, where revoking one leaves the other valid;
  - v1 clients against the upgraded servers.
- The Slurm runner is tested against fake `sbatch`, `squeue`, `sacct`,
  `scontrol` and `scancel` scripts that replay recorded outputs. Cases:
  - every terminal state in the table above;
  - empty and delayed accounting, including a job accepted before midnight and
    reconciled after it;
  - a crash after `sbatch` accepts but before the ID is saved;
  - cancelling while `submitting` and while `pending`;
  - shutdown and restart while running;
  - a second instance against the same data directory, from the same host and
    from another host, including two starting at once against a stale lock.
- The real-cluster validation run and `check-slurm` on that cluster are manual
  release gates, recorded with the cluster, versions and timings.

## Consequences

- The app runs RELION, not CryoSPARC, and its About text says so. Users who need
  CryoSPARC keep using its own interface.
- The compute server gains a second deployment shape (per user, on HPC, single
  owner) beside the clinic GPU host. The two protocol implementations still
  move together.
- The runner/job-store interface and session revocation change for every
  deployment. Local runners keep their behaviour, but the change touches
  NeSVoR's and SCT's execution path, and their tests must stay green.
- Data stays on the cluster. Only small results reach the browser.
- RELION's GUI cannot open the app's projects in the first release.
- Not decided here: multi-node MPI, CTF refinement and polishing, 3D
  classification, Topaz, live processing during collection, PBS and LSF, Open
  OnDemand, the hosted page as a client, CVMFS images, and how the app displays
  classes and maps.

## Order of work

1. The `relion` container built for every CUDA architecture the clusters use.
2. Protocol document: single-owner mode, projects, data roots, the outputs and
   upload changes, the timing constants, the cancel text for Slurm jobs and the
   `interrupted` and `scheduler-lost` error codes. Reviewed before code.
3. Both servers with the simulated `relion` tool and the conformance tests.
4. The runner status channel and the Slurm runner, tested against fake Slurm
   commands.
5. The container's SIF on Hugging Face, and the `relion` tool, command by
   command against `note.txt`.
6. The microscopy app, then the real-cluster validation run.
