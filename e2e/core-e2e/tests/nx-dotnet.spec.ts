import {
  NxJsonConfiguration,
  getPackageManagerCommand,
  joinPathFragments,
  names,
  normalizePath,
} from '@nx/devkit';
import {
  checkFilesExist,
  listFiles,
  readFile,
  runCommand,
  tmpProjPath,
  uniq,
  updateFile,
} from '@nx/plugin/testing';

import { exec, execSync } from 'child_process';
import { unlinkSync, writeFileSync } from 'fs';
import { ensureDirSync } from 'fs-extra';
import { basename, dirname, join } from 'path';
import { XmlDocument } from 'xmldoc';
import * as logger from 'console';
import stripAnsi = require('strip-ansi');

import { readDependenciesFromNxDepGraph } from '@nx-dotnet/utils/e2e';

import { runCommandUntil } from '../../utils';

const e2eDir = tmpProjPath();

describe('nx-dotnet e2e', () => {
  beforeAll(() => {
    setupWorkspace();
  }, 1500000);

  afterEach(async () => {
    await runNxCommandAsync('reset');
  });

  it('should initialize workspace build customization', async () => {
    await runNxCommandAsync(`generate @nx-dotnet/core:init`);

    expect(() =>
      checkFilesExist('Directory.Build.props', 'Directory.Build.targets'),
    ).not.toThrow();
  });

  it('should create apps, libs, and project references', async () => {
    const testApp = uniq('app');
    const testLib = uniq('lib');

    await runNxCommandAsync(
      `generate @nx-dotnet/core:app ${testApp} --language="C#" --template="webapi" --skipSwaggerLib`,
    );

    await runNxCommandAsync(
      `generate @nx-dotnet/core:lib ${testLib} --language="C#" --template="classlib"`,
    );

    const output = await runNxCommandAsync(
      `generate @nx-dotnet/core:project-reference ${testApp} ${testLib}`,
    );

    expect(output.stdout).toMatch(/Reference .* added to the project/);
  });

  it('should work with affected', async () => {
    const testApp = uniq('app');
    const testLib = uniq('lib');

    runCommand('git checkout -b "affected-tests"', {});

    await runNxCommandAsync(
      `generate @nx-dotnet/core:app ${testApp} --language="C#" --template="webapi" --skipSwaggerLib`,
    );

    await runNxCommandAsync(
      `generate @nx-dotnet/core:lib ${testLib} --language="C#" --template="classlib"`,
    );

    await runNxCommandAsync(
      `generate @nx-dotnet/core:project-reference ${testApp} ${testLib}`,
    );

    const deps = await readDependenciesFromNxDepGraph(join(e2eDir), testApp);
    expect(deps).toContain(testLib);
    runCommand('git checkout main', {});
  }, 300000);

  describe('nx g app', () => {
    it('should obey dry-run', async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --skipSwaggerLib --dry-run`,
      );

      expect(() => checkFilesExist(`apps/${app}`)).toThrow();
    });

    it('should generate an app without swagger library', async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --skip-swagger-lib`,
      );

      expect(() => checkFilesExist(`apps/${app}`)).not.toThrow();
      expect(() =>
        checkFilesExist(`libs/generated/${app}-swaggger/project.json`),
      ).toThrow();
    });

    it('should generate an app without launchSettings.json', async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --args="--exclude-launch-settings=true"`,
      );

      expect(() => checkFilesExist(`apps/${app}`)).not.toThrow();
      expect(() =>
        checkFilesExist(`apps/${app}/Properties/launchSettings.json`),
      ).toThrow();
    });

    it('should build and test an app', async () => {
      const app = uniq('app');
      const testProj = `${app}-test`;
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --skip-swagger-lib`,
      );

      await runNxCommandAsync(`build ${app}`);
      await runNxCommandAsync(`test ${testProj}`);

      expect(() => checkFilesExist(`apps/${app}`)).not.toThrow();
      expect(() => checkFilesExist(`dist/apps/${app}`)).not.toThrow();
    });

    it('should build an app which depends on a lib', async () => {
      const app = uniq('app');
      const lib = uniq('lib');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --skip-swagger-lib`,
      );
      await runNxCommandAsync(
        `generate @nx-dotnet/core:lib ${lib} --language="C#" --template="classlib"`,
      );
      await runNxCommandAsync(
        `generate @nx-dotnet/core:project-reference --project ${app} --reference ${lib}`,
      );

      await runNxCommandAsync(`build ${app}`);

      expect(() => checkFilesExist(`apps/${app}`)).not.toThrow();
      expect(() => checkFilesExist(`dist/apps/${app}`)).not.toThrow();
      expect(() => checkFilesExist(`dist/libs/${lib}`)).not.toThrow();
    });

    it('should lint', async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --template webapi --language="C#"  --skip-swagger-lib`,
      );
      const promise = runNxCommandAsync(`lint ${app}`);
      await expect(promise).rejects.toThrow(
        expect.objectContaining({
          message: expect.stringContaining('WHITESPACE'),
        }),
      );
    });
  });

  describe('nx g test', () => {
    it('should add a reference to the target project', async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --skip-swagger-lib --test-template="none"`,
      );
      await runNxCommandAsync(
        `generate @nx-dotnet/core:test ${app} --language="C#" --template="nunit"`,
      );

      const config = readFile(
        joinPathFragments(
          'apps',
          `${app}-test`,
          `Proj.${names(app).className}.Test.csproj`,
        ),
      );
      const projectXml = new XmlDocument(config);

      const projectReferences = projectXml
        .childrenNamed('ItemGroup')
        .flatMap((x) => x.childrenNamed('ProjectReference'));

      expect(
        projectReferences.some(
          (ref) =>
            normalizePath(ref.attr['Include']) ===
            `../${app}/Proj.${names(app).className}.csproj`,
        ),
      ).toBe(true);
    });

    it('should create test project using suffix', async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --skip-swagger-lib --test-template="none"`,
      );
      await runNxCommandAsync(
        `generate @nx-dotnet/core:test ${app} --language="C#" --template="nunit" --suffix="integration-tests"`,
      );

      const config = readFile(
        joinPathFragments(
          'apps',
          `${app}-integration-tests`,
          `Proj.${names(app).className}.IntegrationTests.csproj`,
        ),
      );

      expect(config).toBeDefined();
    });
  });

  describe('nx g lib', () => {
    it('should obey dry-run', async () => {
      const lib = uniq('lib');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:lib ${lib} --language="C#" --template="webapi" --skip-swagger-lib --dry-run`,
      );

      expect(() => checkFilesExist(`libs/${lib}`)).toThrow();
    });

    it('should generate an lib', async () => {
      const lib = uniq('lib');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:lib ${lib} --language="C#" --template="classlib"`,
      );

      expect(() => checkFilesExist(`libs/${lib}`)).not.toThrow();
    });
  });

  describe('nx g using dotnet pathSchema', () => {
    it('no directory', async () => {
      const libName = uniq('CurveDental.Foobar.SomeLib');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:lib ${libName} --language="C#" --template="classlib" --pathScheme=dotnet`,
      );

      expect(() => checkFilesExist(`libs/${libName}`)).not.toThrow();
      expect(() => checkFilesExist(`libs/${libName}.Test`)).not.toThrow();
    });

    it('with directory', async () => {
      const libName = uniq('CurveDental.Foobar.SomeLib');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:lib ${libName} --language="C#" --template="classlib" --pathScheme=dotnet --directory foo`,
      );

      expect(() => checkFilesExist(`libs/foo/${libName}`)).not.toThrow();
      expect(() => checkFilesExist(`libs/foo/${libName}.Test`)).not.toThrow();
    });
  });

  describe('solution handling', () => {
    // For solution handling, defaults fall back to if a file exists.
    // This ensures that the tests are ran in a clean state, without previous
    // test projects interfering with the test.
    beforeAll(() => {
      setupWorkspace();
    }, 1500000);

    it("shouldn't create a solution by default if not specified", async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --skip-swagger-lib --template="webapi"`,
      );

      expect(() => checkFilesExist(`apps/${app}`)).not.toThrow();
      expect(listFiles('.').filter((x) => x.endsWith('.sln'))).toHaveLength(0);
    });

    it('should create a default solution file if specified as true', async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --skip-swagger-lib --solutionFile`,
      );

      expect(() => checkFilesExist(`apps/${app}`)).not.toThrow();
      expect(listFiles('.').filter((x) => x.endsWith('.sln'))).toHaveLength(1);
    });

    it('should create specified solution file if specified as string', async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --solutionFile="MyCompany.sln" --skip-swagger-lib`,
      );

      expect(() =>
        checkFilesExist(`apps/${app}`, `MyCompany.sln`),
      ).not.toThrow();
    });

    it('should add successive projects to default solution file', async () => {
      const app1 = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app1} --language="C#" --skip-swagger-lib --template="webapi" --solutionFile`,
      );

      const app2 = uniq('app2');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app2} --language="C#" --skip-swagger-lib --template="webapi" --solutionFile`,
      );

      const slnFile = readFile('proj.nx-dotnet.sln');

      expect(() => checkFilesExist(`apps/${app1}`)).not.toThrow();
      expect(slnFile).toContain(app1);
      expect(slnFile).toContain(app2);
    });

    it('should add test project to same solution as app project', async () => {
      const app = uniq('app');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --skip-swagger-lib --test-template="xunit" --solutionFile`,
      );

      const slnFile = readFile('proj.nx-dotnet.sln');
      expect(() => checkFilesExist(`apps/${app}`)).not.toThrow();
      expect(slnFile).toContain(app);
      expect(slnFile).toContain(app + '-test');
    });

    it('should work with --dry-run', async () => {
      runCommand('npx -y rimraf *.sln', {});

      const app = uniq('app');
      const output = await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${app} --language="C#" --template="webapi" --skip-swagger-lib --solutionFile --dry-run`,
      );

      expect(stripAnsi(output.stdout)).toContain('CREATE proj.nx-dotnet.sln');
      expect(() => checkFilesExist(`apps/${app}`)).toThrow();
      expect(listFiles('.').filter((x) => x.endsWith('.sln'))).toHaveLength(0);
    });
  });

  describe('inferred targets', () => {
    let api: string;
    let projectFolder: string;

    beforeAll(() => {
      api = uniq('api');
      projectFolder = join(e2eDir, 'apps', api);
      ensureDirSync(projectFolder);
      execSync(`dotnet new webapi --language C#`, {
        cwd: projectFolder,
      });
      updateFile('nx.json', (contents) => {
        const json = JSON.parse(contents);
        json.plugins = ['@nx-dotnet/core'];
        return JSON.stringify(json, null, 2);
      });
    });

    it('should work with project.json', async () => {
      writeFileSync(
        join(projectFolder, 'project.json'),
        JSON.stringify({
          targets: {},
        }),
      );
      await expect(runNxCommandAsync(`build ${api}`)).resolves.toEqual(
        expect.anything(),
      );
    });

    it('should work without project.json', async () => {
      const projectJsonContents = readFile(
        joinPathFragments('apps', api, 'project.json'),
      );
      unlinkSync(join(projectFolder, 'project.json'));

      await expect(runNxCommandAsync(`build ${api}`)).resolves.toEqual(
        expect.anything(),
      );

      writeFileSync(join(projectFolder, 'project.json'), projectJsonContents);
    });
  });

  describe('@nx-dotnet/core:test', () => {
    it('should test with xunit', async () => {
      const appProject = uniq('app');
      const testProject = `${appProject}-test`;
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${appProject} --language="C#" --template="webapi" --skip-swagger-lib --test-runner xunit`,
      );

      await expect(runNxCommandAsync(`test ${testProject}`)).resolves.toEqual(
        expect.anything(),
      );

      updateFile(
        `apps/${testProject}/UnitTest1.cs`,
        `using Xunit;

namespace Proj.${names(appProject).className}.Test;

public class UnitTest1
{
    // This test should fail, as the e2e test is checking for test failures.
    [Fact]
    public void Test1()
    {
      Assert.Equal(1, 2);
    }
}`,
      );

      expect(runNxCommandAsync(`test ${testProject}`)).rejects.toThrow();
    });

    it('should work with watch', async () => {
      const appProject = uniq('app');
      const testProject = `${appProject}-test`;
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${appProject} --language="C#" --template="webapi" --skip-swagger-lib --test-runner xunit`,
      );
      const p = runCommandUntil(
        `test ${testProject} --watch`,
        (output) =>
          output.includes(
            'Waiting for a file to change before restarting dotnet...',
          ),
        { kill: true },
      );
      await expect(p).resolves.not.toThrow();
    });
  });

  describe('swagger integration', () => {
    it('should generate swagger project for webapi', async () => {
      const api = uniq('api');
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${api} --language="C#" --template="webapi" --skipSwaggerLib=false`,
      );

      expect(() => checkFilesExist(`apps/${api}`)).not.toThrow();
      expect(() =>
        checkFilesExist(`libs/generated/${api}-swagger`),
      ).not.toThrow();
      await expect(runNxCommandAsync(`swagger ${api}`)).resolves.toEqual(
        expect.anything(),
      );
      expect(() =>
        checkFilesExist(`libs/generated/${api}-swagger/swagger.json`),
      ).not.toThrow();
    });

    it('should generate swagger project using dotnet pathScheme', async () => {
      const apiName = uniq('CurveDental.Foobar.SomeApi');
      const apiNxProjectName = names(apiName).fileName;
      await runNxCommandAsync(
        `generate @nx-dotnet/core:app ${apiName} --language="C#" --pathScheme=dotnet --template="webapi" --skipSwaggerLib=false`,
      );

      expect(() => checkFilesExist(`apps/${apiName}`)).not.toThrow();
      expect(() =>
        checkFilesExist(`libs/generated/${apiNxProjectName}-swagger`),
      ).not.toThrow();
      await expect(runNxCommandAsync(`swagger ${apiName}`)).resolves.toEqual(
        expect.anything(),
      );
      expect(() =>
        checkFilesExist(
          `libs/generated/${apiNxProjectName}-swagger/swagger.json`,
        ),
      ).not.toThrow();
    });
  });
});

function initializeGitRepo(cwd: string) {
  runCommand('git init', {});
  runCommand('git branch -m main', {});
  runCommand('git config user.email no-one@some-website.com', {});
  runCommand('git config user.name CI-Bot', {});
  runCommand('git add .', {});
  runCommand('git commit -m "initial commit" --no-gpg-sign', {});
}

function runCommandAsync(
  command: string,
  opts = {
    silenceError: false,
    nxVerboseLogging: true,
  },
) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    exec(
      command,
      {
        cwd: e2eDir,
        env: opts.nxVerboseLogging
          ? { ...process.env, NX_VERBOSE_LOGGING: 'true' }
          : process.env,
      },
      (err, stdout, stderr) => {
        if (!opts.silenceError && err) {
          console.log(err, stdout + stderr);
          reject(err);
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
/**
 * Run a nx command asynchronously inside the e2e directory
 * @param command
 * @param opts
 */
function runNxCommandAsync(
  command: string,
  opts = {
    silenceError: false,
    nxVerboseLogging: true,
  },
) {
  const pmc = getPackageManagerCommand();
  return runCommandAsync(`${pmc.exec} nx ${command}`, opts);
}

function setupWorkspace() {
  logger.log('Creating a sandbox project in ', e2eDir);
  const workspaceName = basename(e2eDir);
  const workspaceParentDir = dirname(e2eDir);
  ensureDirSync(workspaceParentDir);
  runCommand(
    `npx create-nx-workspace@latest ${workspaceName} --preset=apps --nxCloud=skip --no-interactive`,
    {
      cwd: workspaceParentDir,
    },
  );
  runCommand(`${getPackageManagerCommand().add} @nx-dotnet/core@e2e`, {
    cwd: e2eDir,
  });
  logger.log('✅');
  // TODO: Update e2e tests and plugin generators to use the new workspace layout semantics.
  updateFile('nx.json', (contents) => {
    const nxJson: NxJsonConfiguration = JSON.parse(contents);
    nxJson.workspaceLayout ??= {};
    nxJson.workspaceLayout.appsDir = 'apps';
    nxJson.workspaceLayout.libsDir = 'libs';
    nxJson.useDaemonProcess = false;
    return JSON.stringify(nxJson, null, 2);
  });
  logger.log('Initializing git repo');
  initializeGitRepo(e2eDir);
  logger.log('✅');
}
