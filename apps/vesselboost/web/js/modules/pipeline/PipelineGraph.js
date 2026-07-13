export const PIPELINE_NODE_ORDER = [
  'load',
  'downsample',
  'n4',
  'denoise',
  'inference',
  'bet'
];

export const STAGE_TO_NODE = {
  input: 'load',
  downsample: 'downsample',
  n4: 'n4',
  nlm: 'denoise',
  segmentation: 'inference',
  bet: 'bet',
  brainmask: 'bet'
};

export const NODE_TO_STAGES = {
  load: ['input'],
  downsample: ['downsample'],
  n4: ['n4'],
  denoise: ['nlm'],
  inference: ['segmentation'],
  bet: ['bet', 'brainmask']
};

const DEPENDENCIES = {
  load: [],
  downsample: ['load'],
  n4: ['downsample'],
  denoise: ['n4'],
  inference: ['denoise', 'bet'],
  bet: ['n4']
};

const DESCENDANTS = buildDescendants(DEPENDENCIES);

function buildDescendants(dependencies) {
  const descendants = {};
  for (const node of Object.keys(dependencies)) descendants[node] = new Set();
  for (const [node, parents] of Object.entries(dependencies)) {
    for (const parent of parents) {
      descendants[parent]?.add(node);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const node of Object.keys(descendants)) {
      for (const child of [...descendants[node]]) {
        for (const grandchild of descendants[child] || []) {
          if (!descendants[node].has(grandchild)) {
            descendants[node].add(grandchild);
            changed = true;
          }
        }
      }
    }
  }

  return Object.fromEntries(
    Object.entries(descendants).map(([node, values]) => [node, [...values]])
  );
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return '{' + Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(',') + '}';
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function cloneParams(params = {}) {
  return JSON.parse(JSON.stringify(params || {}));
}

export class PipelineGraph {
  constructor() {
    this.reset();
  }

  reset() {
    this.sourceDigest = null;
    this.nodes = new Map();
    this.artifacts = new Map();
    this.stageArtifacts = new Map();
    this.invalidatedArtifactIds = [];

    for (const id of PIPELINE_NODE_ORDER) {
      this.nodes.set(id, {
        id,
        status: 'pending',
        mode: id === 'load' ? 'run' : null,
        params: {},
        paramsHash: hashString('{}'),
        dependencyHash: null,
        artifactIds: []
      });
    }
  }

  loadSource({ file, digest, spatial } = {}) {
    this.reset();
    this.sourceDigest = digest || `source:${Date.now()}`;
    const artifact = this.recordArtifact('load', {
      stage: 'input',
      role: 'source',
      file,
      description: file?.name || 'Input',
      spatial
    });
    const node = this.nodes.get('load');
    node.status = 'complete';
    node.mode = 'run';
    node.dependencyHash = this.sourceDigest;
    return artifact;
  }

  setNodeRunning(nodeId, { mode = 'run', params = {} } = {}) {
    const node = this._getNode(nodeId);
    node.status = 'running';
    node.mode = mode;
    node.params = cloneParams(params);
    node.paramsHash = hashString(stableStringify(node.params));
    node.dependencyHash = this.computeDependencyHash(nodeId);
    return node;
  }

  markNodeSkipped(nodeId, params = {}) {
    const node = this._getNode(nodeId);
    this.invalidateFrom(nodeId, { includeSelf: true });
    node.status = 'skipped';
    node.mode = 'skip';
    node.params = cloneParams(params);
    node.paramsHash = hashString(stableStringify(node.params));
    node.dependencyHash = this.computeDependencyHash(nodeId);
    return node;
  }

  markNodeComplete(nodeId, { mode = 'run', params = null } = {}) {
    const node = this._getNode(nodeId);
    node.status = mode === 'skip' ? 'skipped' : 'complete';
    node.mode = mode;
    if (params) {
      node.params = cloneParams(params);
      node.paramsHash = hashString(stableStringify(node.params));
    }
    node.dependencyHash = this.computeDependencyHash(nodeId);
    return node;
  }

  markNodePending(nodeId) {
    const node = this._getNode(nodeId);
    node.status = 'pending';
    node.mode = null;
    node.params = {};
    node.paramsHash = hashString('{}');
    node.dependencyHash = null;
    node.artifactIds = [];
    return node;
  }

  recordArtifact(nodeId, artifact = {}) {
    const node = this._getNode(nodeId);
    const id = artifact.id || `${nodeId}:${artifact.stage || artifact.role || 'artifact'}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const stored = {
      id,
      nodeId,
      stage: artifact.stage,
      role: artifact.role || artifact.stage,
      file: artifact.file || null,
      description: artifact.description || '',
      spatial: artifact.spatial || null,
      paramsHash: node.paramsHash,
      dependencyHash: node.dependencyHash || this.computeDependencyHash(nodeId),
      createdAt: artifact.createdAt || Date.now()
    };
    this.artifacts.set(id, stored);
    node.artifactIds.push(id);
    if (stored.stage) this.stageArtifacts.set(stored.stage, id);
    return stored;
  }

  invalidateFrom(nodeId, { includeSelf = false } = {}) {
    const nodes = includeSelf
      ? [nodeId, ...(DESCENDANTS[nodeId] || [])]
      : [...(DESCENDANTS[nodeId] || [])];
    const removedStages = [];
    const removedArtifactIds = [];

    for (const id of nodes) {
      const node = this.nodes.get(id);
      if (!node) continue;
      for (const artifactId of node.artifactIds) {
        const artifact = this.artifacts.get(artifactId);
        if (artifact?.stage) {
          this.stageArtifacts.delete(artifact.stage);
          removedStages.push(artifact.stage);
        }
        this.artifacts.delete(artifactId);
        removedArtifactIds.push(artifactId);
      }
      node.artifactIds = [];
      if (id !== 'load') {
        node.status = 'pending';
        node.mode = null;
        node.dependencyHash = null;
      }
    }

    this.invalidatedArtifactIds.push(...removedArtifactIds);
    return {
      nodes,
      stages: [...new Set(removedStages)],
      artifactIds: removedArtifactIds
    };
  }

  drainInvalidatedArtifactIds() {
    const ids = [...this.invalidatedArtifactIds];
    this.invalidatedArtifactIds = [];
    return ids;
  }

  snapshot() {
    return {
      sourceDigest: this.sourceDigest,
      nodes: [...this.nodes.entries()].map(([id, node]) => [id, {
        ...node,
        params: cloneParams(node.params),
        artifactIds: [...node.artifactIds]
      }]),
      artifacts: [...this.artifacts.entries()],
      stageArtifacts: [...this.stageArtifacts.entries()],
      invalidatedArtifactIds: [...this.invalidatedArtifactIds]
    };
  }

  restore(snapshot) {
    if (!snapshot) return;
    this.sourceDigest = snapshot.sourceDigest || null;
    this.nodes = new Map((snapshot.nodes || []).map(([id, node]) => [id, {
      ...node,
      params: cloneParams(node.params),
      artifactIds: [...(node.artifactIds || [])]
    }]));
    this.artifacts = new Map(snapshot.artifacts || []);
    this.stageArtifacts = new Map(snapshot.stageArtifacts || []);
    this.invalidatedArtifactIds = [...(snapshot.invalidatedArtifactIds || [])];
  }

  computeDependencyHash(nodeId) {
    if (nodeId === 'load') return this.sourceDigest;
    const node = this._getNode(nodeId);
    const parentHashes = (DEPENDENCIES[nodeId] || []).map(parentId => {
      const parent = this.nodes.get(parentId);
      return `${parentId}:${parent?.mode || 'unset'}:${parent?.paramsHash || 'unset'}:${parent?.dependencyHash || 'unset'}`;
    });
    return hashString(`${this.sourceDigest}|${nodeId}|${node.paramsHash}|${parentHashes.join('|')}`);
  }

  getNodeStatus(nodeId) {
    return this.nodes.get(nodeId)?.status || 'pending';
  }

  getStageArtifact(stage) {
    const id = this.stageArtifacts.get(stage);
    return id ? this.artifacts.get(id) || null : null;
  }

  getStageArtifactsInOrder() {
    const stages = [];
    for (const nodeId of PIPELINE_NODE_ORDER) {
      for (const stage of NODE_TO_STAGES[nodeId] || []) {
        if (stage === 'input') continue;
        if (this.stageArtifacts.has(stage)) stages.push(stage);
      }
    }
    return stages;
  }

  getNodeForStage(stage) {
    return STAGE_TO_NODE[stage] || stage;
  }

  _getNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Unknown pipeline node: ${nodeId}`);
    return node;
  }
}
