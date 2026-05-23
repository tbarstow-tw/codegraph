import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Django end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('creates a route->view edge from urls.py to view class', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-django-'));
    fs.writeFileSync(path.join(tmpDir, 'manage.py'), '# marker\n');
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'django==4.2\n');
    fs.mkdirSync(path.join(tmpDir, 'users'));
    fs.writeFileSync(path.join(tmpDir, 'users/__init__.py'), '');
    fs.writeFileSync(
      path.join(tmpDir, 'users/views.py'),
      'class UserListView:\n    def get(self, request): pass\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'users/urls.py'),
      'from django.urls import path\n' +
        'from users.views import UserListView\n' +
        'urlpatterns = [path("users/", UserListView.as_view(), name="user-list")]\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Route node exists
    const routes = cg.getNodesByKind('route');
    expect(routes.length).toBeGreaterThan(0);
    const route = routes.find((n) => n.name === 'users/');
    expect(route).toBeDefined();

    // View class exists
    const classNodes = cg.getNodesByKind('class');
    const view = classNodes.find((n) => n.name === 'UserListView');
    expect(view).toBeDefined();

    // Edge route -> view exists
    const edges = cg.getOutgoingEdges(route!.id);
    const toView = edges.find((e) => e.target === view!.id);
    expect(toView).toBeDefined();
    expect(toView!.kind).toBe('references');

    cg.close();
  });
});

describe('Flask end-to-end framework extraction', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves stacked routes across @login_required to a view named after a builtin (index)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flask-'));
    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), 'flask==3.0\n');
    fs.writeFileSync(
      path.join(tmpDir, 'app.py'),
      'from flask import Blueprint, render_template\n' +
        'from flask_login import login_required\n' +
        'bp = Blueprint("main", __name__)\n' +
        '\n' +
        '@bp.route("/", methods=["GET", "POST"])\n' +
        '@bp.route("/index", methods=["GET", "POST"])\n' +
        '@login_required\n' +
        'def index():\n' +
        '    return render_template("index.html")\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    // Both stacked @bp.route decorators are extracted (the second was previously
    // dropped because @login_required broke the "def must follow" assumption).
    const routes = cg.getNodesByKind('route');
    expect(routes.map((r) => r.name).sort()).toEqual(['GET /', 'GET /index']);

    // The view function exists even though its name is a Python builtin method.
    const fn = cg.getNodesByKind('function').find((n) => n.name === 'index');
    expect(fn).toBeDefined();

    // Both routes resolve to it — exercises the bare-name builtin guard, which
    // previously filtered the `index` reference as a builtin method.
    for (const route of routes) {
      const edges = cg.getOutgoingEdges(route.id);
      const toView = edges.find((e) => e.target === fn!.id && e.kind === 'references');
      expect(toView, `route ${route.name} should resolve to index()`).toBeDefined();
    }

    cg.close();
  });
});
