import { definePipeline } from './PipelineDefinition.js';

export class PipelineRegistry {
  constructor(pipelines = []) {
    this.pipelines = new Map();
    for (const pipeline of pipelines) this.register(pipeline);
  }

  register(pipeline) {
    const definition = Object.isFrozen(pipeline) ? pipeline : definePipeline(pipeline);
    if (this.pipelines.has(definition.id)) throw new Error(`Pipeline already registered: ${definition.id}`);
    this.pipelines.set(definition.id, definition);
    return definition;
  }

  unregister(id) {
    return this.pipelines.delete(id);
  }

  get(id) {
    return this.pipelines.get(id) || null;
  }

  list(filter = null) {
    const values = Array.from(this.pipelines.values());
    return typeof filter === 'function' ? values.filter(filter) : values;
  }

  require(id) {
    const pipeline = this.get(id);
    if (!pipeline) throw new Error(`Pipeline not found: ${id}`);
    return pipeline;
  }

  registerPlugin(plugin) {
    for (const pipeline of plugin?.pipelines || []) this.register(pipeline);
  }
}
