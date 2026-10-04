import { createComputeConnection, createFileField, createResultList, renderSidebarSection } from '@neurodesk/webapp-components/ui';
import { downloadFile } from '@neurodesk/webapp-components/file-io';
import { SCT_IMAGE, SCT_VERSION, validateSctSpec } from '../app/analysis-spec.js';

export class SctAnalysis {
    constructor({ before, progress, log, canRun = () => true }) {
        this.progress = progress;
        this.log = log;
        this.canRun = canRun;
        this.generated = {};
        this.uploaded = {};
        this.revision = 0;
        this.job = null;
        this.outputs = {};
        const section = renderSidebarSection({ id: 'sctAnalysisSection', title: 'Native SCT analysis', collapsed: true });
        before.before(section.root);
        this.section = section.root;
        section.content.innerHTML = `
            <div class="nd-field">
                <label for="sctAnalysisCommand">Analysis</label>
                <select id="sctAnalysisCommand">
                    <option value="process_segmentation">Cord morphometry</option>
                    <option value="analyze_lesion">Lesion analysis</option>
                </select>
            </div>
            <p class="nd-hint">Run sends selected masks to your compute server. No anatomy image is required.</p>
            <div id="sctAnalysisCord" class="nd-field">
                <label for="sctCordSource">Cord mask</label>
                <select id="sctCordSource"><option value="upload">Upload NIfTI mask</option></select>
            </div>
            <div id="sctAnalysisLesion" class="nd-field" hidden>
                <label for="sctLesionSource">Lesion mask</label>
                <select id="sctLesionSource"><option value="upload">Upload NIfTI mask</option></select>
            </div>
            <details id="sctMorphometryOptions" class="nd-sidebar-section">
                <summary class="nd-section-title">Morphometry settings</summary>
                <div class="nd-section-content">
                    <label class="nd-check"><input id="sctPerSlice" type="checkbox"> Per slice</label>
                    <label class="nd-check"><input id="sctAngleCorrection" type="checkbox" checked> Angle correction</label>
                    <div class="nd-field">
                        <label for="sctSlices">Slice indices</label>
                        <input id="sctSlices" type="text" placeholder="All slices" aria-describedby="sctSlicesHelp">
                        <p id="sctSlicesHelp" class="nd-hint">SCT superior-inferior indices, e.g. 2:12,15.</p>
                    </div>
                </div>
            </details>
            <details class="nd-sidebar-section" open>
                <summary class="nd-section-title">Compute server</summary>
                <div id="sctComputeControl" class="nd-section-content"></div>
            </details>
            <button id="sctRunAnalysis" type="button" class="nd-btn nd-btn-secondary">Run analysis</button>
            <details id="sctPreviousJobs" class="nd-sidebar-section" hidden>
                <summary class="nd-section-title">Previous analysis jobs</summary>
                <div class="nd-section-content">
                    <div class="nd-field"><label for="sctPreviousJob">Job</label><select id="sctPreviousJob"></select></div>
                    <div class="nd-row">
                        <button id="sctRefreshJobs" type="button" class="nd-btn nd-btn-secondary">Refresh</button>
                        <button id="sctResumeJob" type="button" class="nd-btn nd-btn-secondary">Open job</button>
                        <button id="sctDeleteJob" type="button" class="nd-btn nd-btn-secondary">Delete job</button>
                    </div>
                </div>
            </details>`;
        const get = id => section.root.querySelector(`#${id}`);
        this.command = get('sctAnalysisCommand');
        this.perSlice = get('sctPerSlice');
        this.angleCorrection = get('sctAngleCorrection');
        this.slices = get('sctSlices');
        this.optionsPanel = get('sctMorphometryOptions');
        this.runButton = get('sctRunAnalysis');
        this.sources = {};
        this.fields = {};
        this.rolePanels = {};
        for (const role of ['cord', 'lesion']) {
            const title = role === 'cord' ? 'Cord' : 'Lesion';
            const source = get(`sct${title}Source`);
            const field = createFileField({ id: `sct${title}Mask`, kind: 'dataset', multiple: false, accept: '.nii,.nii.gz', text: `Choose ${role} mask (NIfTI)` });
            source.parentElement.append(field);
            field.onFiles(async files => {
                try {
                    const selected = await files;
                    if (selected.length !== 1) throw new Error('Choose one NIfTI mask');
                    this.uploaded[role] = selected[0];
                    field.setText(selected[0].name);
                    field.setHasFiles(true);
                    this.invalidate();
                } catch (error) { this.progress.end(error.message, { success: false }); }
            });
            source.onchange = () => { this.invalidate(); this.sync(); };
            this.sources[role] = source;
            this.fields[role] = field;
            this.rolePanels[role] = source.parentElement;
        }
        this.connection = createComputeConnection({ id: 'sctComputeConnection', storageKey: 'sct.compute', autodetect: false, tool: 'sct' });
        get('sctComputeControl').append(this.connection);
        this.connection.addEventListener('nd-compute-change', () => { this.sync(); void this.refreshJobs(); });
        this.command.onchange = () => { this.invalidate(); this.updateSources(); };
        for (const input of [this.perSlice, this.angleCorrection, this.slices]) input.onchange = () => this.invalidate();
        this.runButton.onclick = () => void this.run();
        this.previousPanel = get('sctPreviousJobs');
        this.previous = get('sctPreviousJob');
        this.refreshButton = get('sctRefreshJobs');
        this.resumeButton = get('sctResumeJob');
        this.deleteButton = get('sctDeleteJob');
        this.refreshButton.onclick = () => void this.refreshJobs();
        this.resumeButton.onclick = () => void this.run(this.previous.value);
        this.deleteButton.onclick = async () => {
            if (this.busy || !this.previous.value) return;
            try {
                await this.connection.client.remove(this.previous.value);
                this.progress.reset('Server job and files deleted');
                await this.refreshJobs();
            } catch (error) { this.progress.end(error.message, { success: false }); }
        };
        const results = renderSidebarSection({ id: 'sctAnalysisResults', title: 'Native SCT results', collapsed: true });
        section.root.after(results.root);
        this.resultSection = results.root;
        this.resultNote = document.createElement('p');
        this.resultNote.className = 'nd-hint';
        this.results = createResultList({ onDownload: (_stage, result) => downloadFile(result.file) });
        this.table = document.createElement('div');
        this.table.className = 'nd-table-scroll';
        results.content.append(this.resultNote, this.results, this.table);
        this.updateSources();
    }

    get busy() { return Boolean(this.job); }

    setGenerated(results) {
        this.generated = results;
        this.invalidate();
        this.updateSources();
    }

    invalidate() {
        this.revision += 1;
        this.outputs = {};
        this.results.render();
        this.table.replaceChildren();
        this.resultNote.textContent = '';
        this.resultSection.open = false;
        if (this.job) void this.cancel();
    }

    updateSources() {
        const lesion = this.command.value === 'analyze_lesion';
        for (const role of ['cord', 'lesion']) {
            const select = this.sources[role];
            const previous = select.value;
            const choices = [['upload', 'Upload NIfTI mask']];
            if (role === 'cord' && lesion) choices.unshift(['none', 'None (lesion mask only)']);
            if (this.generated[role]) choices.push(['generated', `Current generated ${role} mask`]);
            select.replaceChildren(...choices.map(([value, label]) => new Option(label, value)));
            if (choices.some(([value]) => value === previous)) select.value = previous;
            if (role === 'cord' && lesion && previous === 'upload' && !this.uploaded.cord) select.value = 'none';
        }
        this.rolePanels.lesion.hidden = !lesion;
        this.optionsPanel.hidden = lesion;
        this.sync();
    }

    sync() {
        for (const role of ['cord', 'lesion']) {
            this.fields[role].hidden = this.sources[role].value !== 'upload';
            this.fields[role].disabled = this.busy;
            this.sources[role].disabled = this.busy;
        }
        for (const input of [this.command, this.perSlice, this.angleCorrection, this.slices]) input.disabled = this.busy;
        this.connection.disabled = this.busy;
        this.runButton.disabled = this.busy;
        this.resumeButton.disabled = this.busy || !this.previous.value;
        this.deleteButton.disabled = this.busy || !this.previous.value;
    }

    capture() {
        const files = {};
        const spec = { tool: 'sct', command: this.command.value, options: {} };
        const roles = spec.command === 'process_segmentation' ? ['cord'] : ['lesion', 'cord'];
        for (const role of roles) {
            const source = this.sources[role].value;
            if (source === 'none') continue;
            const file = source === 'generated' ? this.generated[role] : this.uploaded[role];
            if (!file) throw new Error(`Choose a ${role} mask`);
            files[role] = file;
            spec[role] = role;
        }
        if (spec.command === 'process_segmentation') {
            spec.options = { perSlice: this.perSlice.checked, angleCorrection: this.angleCorrection.checked };
            if (this.slices.value.trim()) spec.options.slices = this.slices.value.trim();
        }
        return { spec: validateSctSpec(spec, Object.keys(files)), files };
    }

    async run(previousId = null) {
        if (this.busy) return;
        const client = this.connection.client;
        const info = this.connection.info;
        const tool = info?.tools?.find(item => item.id === 'sct');
        try {
            if (!this.canRun()) throw new Error('Wait for local segmentation to finish');
            if (!client) throw new Error('Connect to a compute server first');
            if (!tool || tool.version !== SCT_VERSION || tool.image !== SCT_IMAGE || (!info.simulated && info.runner !== 'docker')) {
                throw new Error(`Connect to a server with the pinned SCT ${SCT_VERSION} Docker tool`);
            }
            const request = previousId ? null : this.capture();
            this.invalidate();
            const job = { client, id: previousId, cancelled: false, revision: this.revision, key: crypto.randomUUID() };
            this.job = job;
            this.sync();
            this.progress.begin(previousId ? 'Opening server job…' : 'Uploading masks to your compute server…');
            try {
                if (!job.id) {
                    const receipt = await client.submit(request.spec, request.files, { idempotencyKey: job.key });
                    job.id = receipt.id;
                }
                if (job.cancelled) await client.cancel(job.id);
                const current = () => this.job === job && job.revision === this.revision;
                const done = await client.watch(job.id, {
                    onStatus: event => { if (current()) this.progress.setIndeterminate(`SCT analysis ${event.status}`); },
                    onProgress: event => { if (current()) this.progress.setProgress(event.fraction, event.stage); },
                    onLog: event => { if (current()) this.log(event.line); },
                });
                if (job.cancelled || !current()) return;
                this.progress.setText('Downloading native SCT outputs…');
                const artifacts = await Promise.all(done.outputs.map(async output => ({
                    file: new File([await client.output(done.id, output.name)], output.name, { type: output.contentType }),
                    description: output.name,
                    viewable: false,
                })));
                if (job.cancelled || !current()) return;
                this.outputs = Object.fromEntries(artifacts.map(result => [result.file.name, result]));
                this.results.render(this.outputs);
                this.resultNote.textContent = done.simulated ? 'Simulated placeholders. No scientific analysis was performed.' : `Native SCT ${SCT_VERSION} outputs, preserved unchanged.`;
                const csv = this.outputs['morphometry.csv'];
                if (csv) {
                    const text = await csv.file.text();
                    if (!current() || job.cancelled) return;
                    this.renderTable(text);
                }
                if (!current()) return;
                this.resultSection.open = true;
                this.progress.end(done.simulated ? 'Simulated SCT results ready' : 'Native SCT results ready');
            } catch (error) {
                if (job.revision === this.revision) {
                    this.progress.end(error.code === 'cancelled' ? 'Analysis cancelled' : `Analysis interrupted: ${error.message}. Check Previous analysis jobs.`, { success: false });
                }
                this.log(error.message);
            } finally {
                if (this.job === job) {
                    if (job.cancelled && job.revision === this.revision) this.progress.end('Analysis cancelled', { success: false });
                    this.job = null;
                    this.progress.setCancellable(false);
                    this.progress.stopTimer();
                    this.sync();
                    void this.refreshJobs();
                }
            }
        } catch (error) { this.progress.end(error.message, { success: false }); }
    }

    async cancel() {
        const job = this.job;
        if (!job) return;
        job.cancelled = true;
        this.progress.setText('Cancelling analysis…');
        if (job.id) {
            try { await job.client.cancel(job.id); }
            catch (error) { this.log(`Cancellation not confirmed: ${error.message}`); }
        }
    }

    async refreshJobs() {
        const client = this.connection.client;
        this.previousPanel.hidden = !client;
        if (!client) return;
        try {
            const { jobs } = await client.jobs();
            if (client !== this.connection.client) return;
            this.previous.replaceChildren(...jobs.filter(job => job.tool === 'sct').map(job => new Option(`${job.command} · ${job.status} · ${job.createdAt}`, job.id)));
            this.sync();
        } catch (error) { this.log(`Could not list SCT jobs: ${error.message}`); }
    }

    renderTable(csv) {
        const table = document.createElement('table');
        table.className = 'nd-data-table';
        const rows = parseMetricTable(csv);
        rows.slice(0, 501).forEach((cells, index) => {
            const row = document.createElement('tr');
            for (const value of cells) {
                const cell = document.createElement(index === 0 ? 'th' : 'td');
                cell.textContent = value;
                row.append(cell);
            }
            table.append(row);
        });
        this.table.replaceChildren(table);
    }
}

export function parseMetricTable(csv) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < csv.length; i += 1) {
        const char = csv[i];
        if (char === '"') {
            if (quoted && csv[i + 1] === '"') { field += '"'; i += 1; }
            else quoted = !quoted;
        } else if (char === ',' && !quoted) {
            row.push(field);
            field = '';
        } else if ((char === '\n' || char === '\r') && !quoted) {
            if (char === '\r' && csv[i + 1] === '\n') i += 1;
            row.push(field);
            if (row.some(value => value !== '')) rows.push(row);
            row = [];
            field = '';
        } else field += char;
    }
    if (field || row.length) rows.push([...row, field]);
    return rows;
}
