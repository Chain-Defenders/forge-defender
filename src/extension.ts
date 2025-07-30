import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface TestResult {
  name: string;
  status: 'passed' | 'failed' | 'running' | 'pending';
  gasUsed?: number;
  error?: string;
  duration?: number;
  contract: string;
}

export interface TestContract {
  name: string;
  tests: TestResult[];
  path: string;
}

export class FoundryTestProvider implements vscode.TreeDataProvider<TestItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TestItem | undefined | null | void> = new vscode.EventEmitter<TestItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TestItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private contracts: TestContract[] = [];
  private outputChannel: vscode.OutputChannel;

  constructor(private workspaceRoot: string) {
    this.outputChannel = vscode.window.createOutputChannel('ForgeDefender');
  }

  refresh(): void {
    this.discoverTests().then(() => {
      this._onDidChangeTreeData.fire();
    }).catch(error => {
      console.error('Error refreshing tests:', error);
      this.outputChannel.appendLine(`Error refreshing tests: ${error}`);
    });
  }

  getTreeItem(element: TestItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: TestItem): Thenable<TestItem[]> {
    if (!this.workspaceRoot) {
      vscode.window.showInformationMessage('No Foundry project found');
      return Promise.resolve([]);
    }

    if (element) {
      // Return tests for a contract
      const contract = this.contracts.find(c => c.name === element.label);
      if (contract) {
        return Promise.resolve(contract.tests.map(test => new TestItem(
          test.name,
          vscode.TreeItemCollapsibleState.None,
          'test',
          test,
          contract.name
        )));
      }
      return Promise.resolve([]);
    } else {
      // Return contracts
      return Promise.resolve(this.contracts.map(contract => 
        new TestItem(
          contract.name,
          vscode.TreeItemCollapsibleState.Expanded,
          'contract',
          undefined,
          contract.name
        )
      ));
    }
  }

  async discoverTests(): Promise<void> {
    try {
      const config = vscode.workspace.getConfiguration('forgeDefender');
      const testDirectories = config.get<string[]>('testDirectories', ['test', 'tests']);
      const excludePatterns = config.get<string[]>('excludePatterns', [
        '**/node_modules/**', 
        '**/lib/**', 
        '**/deps/**', 
        '**/dependencies/**'
      ]);

      this.contracts = [];

      // Build include patterns for test directories
      const includePatterns = testDirectories.map(dir => `**/${dir}/**/*.sol`);
      
      for (const includePattern of includePatterns) {
        const testFiles = await vscode.workspace.findFiles(
          includePattern, 
          `{${excludePatterns.join(',')}}`
        );

        for (const file of testFiles) {
          // Additional check to ensure we're not including dependency tests
          const relativePath = vscode.workspace.asRelativePath(file);
          const shouldExclude = excludePatterns.some(pattern => {
            const cleanPattern = pattern.replace(/^\*\*\//, '').replace(/\/\*\*$/, '');
            return relativePath.includes(cleanPattern);
          });

          if (!shouldExclude) {
            const contractsInFile = await this.parseTestFile(file);
            if (contractsInFile) {
              this.contracts.push(...contractsInFile);
            }
          }
        }
      }

      this.outputChannel.appendLine(`Discovered ${this.contracts.length} test contracts with ${this.contracts.reduce((sum, c) => sum + c.tests.length, 0)} total tests`);
    } catch (error) {
      console.error('Error discovering tests:', error);
      this.outputChannel.appendLine(`Error discovering tests: ${error}`);
    }
  }
  
  private stripComments(code: string): string {
    // Remove block comments (/* ... */)
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');
    // Remove line comments (// ...)
    code = code.replace(/\/\/.*$/gm, '');
    return code;
  }

  private async parseTestFile(file: vscode.Uri): Promise<TestContract[] | null> {
    try {
      const document = await vscode.workspace.openTextDocument(file);
      const rawContent = document.getText();
      const content = this.stripComments(rawContent);

      // Match all contracts with their start positions
      const contractMatches = [...content.matchAll(/contract\s+(\w+)\s*(?:is\s+[^{]+)?\s*{/g)];

      if (contractMatches.length === 0) return null;

      // Match all test functions with their positions
      const testMatches = [...content.matchAll(/function\s+(test\w*)\s*\(/g)];

      const contracts: TestContract[] = contractMatches.map((match, index) => {
        const contractName = match[1];
        const startPos = match.index ?? 0;
        const endPos = contractMatches[index + 1]?.index ?? content.length;

        // Assign tests that appear between start and end position
        const tests: TestResult[] = testMatches
          .filter(testMatch => {
            const testPos = testMatch.index ?? 0;
            return testPos >= startPos && testPos < endPos;
          })
          .map(testMatch => ({
            name: testMatch[1],
            status: 'pending',
            contract: contractName,
          }));

        return {
          name: contractName,
          tests,
          path: file.fsPath,
        };
      });

      // Filter out contracts without tests
      return contracts.filter(c => c.tests.length > 0);
    } catch (error) {
      console.error('Error parsing test file:', error);
      return null;
    }
  }

  private async runPreTestSetup(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('forgeDefender');
    const runNpmInstall = config.get<boolean>('runNpmInstallBeforeTests', true);
    const runBuild = config.get<boolean>('runBuildBeforeTests', true);

    try {
      // Check if package.json exists and run npm install
      if (runNpmInstall) {
        const packageJsonPath = path.join(this.workspaceRoot, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          this.outputChannel.appendLine('Running npm install...');
          const { stdout: npmStdout, stderr: npmStderr } = await execAsync('npm install', { 
            cwd: this.workspaceRoot,
            timeout: 120000 // 2 minute timeout
          });
          
          if (npmStderr && !npmStderr.includes('WARN')) {
            this.outputChannel.appendLine(`npm install warnings/errors:\n${npmStderr}\n`);
          }
          this.outputChannel.appendLine('npm install completed.\n');
        }
      }

      // Run forge build
      if (runBuild) {
        this.outputChannel.appendLine('Running forge build...');
        const { stdout: buildStdout, stderr: buildStderr } = await execAsync('forge build', { 
          cwd: this.workspaceRoot,
          timeout: 120000 // 2 minute timeout
        });
        
        if (buildStderr) {
          this.outputChannel.appendLine(`Build warnings/errors:\n${buildStderr}\n`);
        }
        
        if (buildStdout) {
          this.outputChannel.appendLine(`Build output:\n${buildStdout}\n`);
        }
        
        this.outputChannel.appendLine('forge build completed.\n');
      }

      return true;
    } catch (error: any) {
      this.outputChannel.appendLine(`Pre-test setup failed: ${error.message}\n`);
      vscode.window.showErrorMessage(`Pre-test setup failed: ${error.message}`);
      return false;
    }
  }

  async runAllTests(): Promise<void> {
    this.outputChannel.clear();
    this.outputChannel.show();
    this.outputChannel.appendLine('=== ForgeDefender ===\n');

    // Run pre-test setup
    const setupSuccess = await this.runPreTestSetup();
    if (!setupSuccess) {
      return;
    }

    this.outputChannel.appendLine('Running all Foundry tests...\n');

    // Set all tests to running
    this.contracts.forEach(contract => {
      contract.tests.forEach(test => test.status = 'running');
    });

    this._onDidChangeTreeData.fire(); // Full tree refresh

    let stdout: string = '';
    let stderr: string = '';
    try {
      const result = await execAsync('forge test --json', { 
        cwd: this.workspaceRoot,
        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: any) {
      stdout = error.stdout || '';
      stderr = error.stderr || '';
      this.outputChannel.appendLine(`Test command failed: ${error.message}\n`);
    }

    // Parse test results if stdout is available
    if (stdout) {
      this.parseTestResults(stdout);
      this.outputChannel.appendLine('Test run completed.\n');
    } else {
      this.outputChannel.appendLine('No test output received.\n');
      // Set all tests to failed only if no output is available
      this.contracts.forEach(contract => {
        contract.tests.forEach(test => test.status = 'failed');
      });
    }

    // Log stderr if present
    if (stderr) {
      this.outputChannel.appendLine(`Test command stderr:\n${stderr}\n`);
    }

    this._onDidChangeTreeData.fire(); // Full tree refresh
  }

  async runSingleTest(contractName: string, testName: string): Promise<void> {
    this.outputChannel.clear();
    this.outputChannel.show();
    this.outputChannel.appendLine('=== ForgeDefender ===\n');

    // Run pre-test setup
    const setupSuccess = await this.runPreTestSetup();
    if (!setupSuccess) {
      return;
    }

    this.outputChannel.appendLine(`Running test: ${contractName}::${testName}\n`);

    // Set specific test to running
    const contract = this.contracts.find(c => c.name === contractName);
    if (contract) {
      const test = contract.tests.find(t => t.name === testName);
      if (test) {
        test.status = 'running';
        this._onDidChangeTreeData.fire(); // Full tree refresh
      }
    }

    let stdout: string = '';
    let stderr: string = '';
    try {
      const result = await execAsync(`forge test --match-test ${testName} --json`, { 
        cwd: this.workspaceRoot 
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: any) {
      stdout = error.stdout || '';
      stderr = error.stderr || '';
      this.outputChannel.appendLine(`Test command failed: ${error.message}\n`);
    }

    // Parse test results if stdout is available
    if (stdout) {
      this.parseTestResults(stdout);
      this.outputChannel.appendLine('Test run completed.\n');
    } else {
      this.outputChannel.appendLine('No test output received.\n');
      if (contract) {
        const test = contract.tests.find(t => t.name === testName);
        if (test) {
          test.status = 'failed';
        }
      }
    }

    // Log stderr if present
    if (stderr) {
      this.outputChannel.appendLine(`Test command stderr:\n${stderr}\n`);
    }

    this._onDidChangeTreeData.fire(); // Full tree refresh
  }
  
  private parseTestResults(jsonOutput: string): void {
    this.outputChannel.appendLine('Parsing test results...\n');
    
    try {
      const resultObj = JSON.parse(jsonOutput);

      for (const fullKey in resultObj) {
        const contractResult = resultObj[fullKey];
        const [filePath, contractName] = fullKey.split(':');

        const contract = this.contracts.find(c => c.name === contractName);
        if (!contract) {
          this.outputChannel.appendLine(`Contract not found: ${contractName}`);
          continue;
        }

        const testResults = contractResult.test_results || {};

        for (const testName in testResults) {
          const testResultData = testResults[testName];

          const test = contract.tests.find(t => t.name === testName || t.name + '()' === testName || (testName.startsWith(t.name + '(') && testName.endsWith(')')));
          if (!test) {
            this.outputChannel.appendLine(`Test not found: ${testName} in contract ${contractName}`);
            continue;
          }

          this.outputChannel.appendLine(`Test: ${testName}`);
          this.outputChannel.appendLine(`Contract: ${contractName}`);
          this.outputChannel.appendLine(`Status: ${testResultData.status}`);

          test.status = testResultData.status === 'Success' ? 'passed' : 'failed';

          const duration = testResultData.duration;
          this.outputChannel.appendLine(`Duration: ${duration ? `${duration.secs}s ${duration.nanos}ns` : 'N/A'}`);
          if (duration) {
            const millis = (duration.secs * 1000) + (duration.nanos / 1e6);
            test.duration = Math.round(millis);
          } else {
            test.duration = 0;
          }

          const gasInfo =
            testResultData.kind?.Unit?.gas ??
            testResultData.kind?.Fuzz?.mean_gas ??
            testResultData.kind?.Fuzz?.first_case?.gas;
          this.outputChannel.appendLine(`Gas Used: ${gasInfo ? gasInfo.toLocaleString() : 'N/A'}`);
          if (gasInfo) {
            test.gasUsed = gasInfo;
          }

          if (testResultData.reason) {
            test.error = testResultData.reason;
          }
        }
      }

      this._onDidChangeTreeData.fire(); // Full tree refresh
    } catch (error) {
      console.error('Error parsing test results:', error);
      this.outputChannel.appendLine(`Error parsing test results: ${error}`);
    }
  }

  showTestOutput(contractName: string, testName: string): void {
    this.outputChannel.show();
    const contract = this.contracts.find(c => c.name === contractName);
    if (contract) {
      const test = contract.tests.find(t => t.name === testName);
      if (test) {
        this.outputChannel.appendLine(`\n=== Test Details ===`);
        this.outputChannel.appendLine(`Contract: ${contractName}`);
        this.outputChannel.appendLine(`Test: ${testName}`);
        this.outputChannel.appendLine(`Status: ${test.status.toUpperCase()}`);
        if (test.gasUsed) {
          this.outputChannel.appendLine(`Gas Used: ${test.gasUsed.toLocaleString()}`);
        }
        if (test.duration) {
          this.outputChannel.appendLine(`Duration: ${test.duration}ms`);
        }
        if (test.error) {
          this.outputChannel.appendLine(`Error: ${test.error}`);
        }
        this.outputChannel.appendLine(`=====================\n`);
      }
    }
  }
}

class TestItem extends vscode.TreeItem {
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly contextValue: string,
    public readonly testResult?: TestResult,
    public readonly contractName?: string
  ) {
    super(label, collapsibleState);

    if (testResult) {
      this.tooltip = this.getTooltip();
      this.iconPath = this.getIcon();
      this.description = this.getDescription();
    }
  }

  private getIcon(): vscode.ThemeIcon {
    if (!this.testResult) return new vscode.ThemeIcon('folder');
    
    switch (this.testResult.status) {
      case 'passed':
        return new vscode.ThemeIcon('check', new vscode.ThemeColor('testing.iconPassed'));
      case 'failed':
        return new vscode.ThemeIcon('close', new vscode.ThemeColor('testing.iconFailed'));
      case 'running':
        return new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('testing.iconQueued'));
      default:
        return new vscode.ThemeIcon('circle-outline', new vscode.ThemeColor('testing.iconUnset'));
    }
  }

  private getDescription(): string {
    if (!this.testResult) return '';
    
    const parts: string[] = [];
    
    if (this.testResult.gasUsed) {
      parts.push(`⛽ ${this.testResult.gasUsed.toLocaleString()}`);
    }
    
    if (this.testResult.duration !== undefined) {
      parts.push(`⏱️ ${this.testResult.duration < 1 ? '<1ms' : `${this.testResult.duration}ms`}`);
    }
    
    return parts.join(' ');
  }

  private getTooltip(): string {
    if (!this.testResult) return '';
    
    let tooltip = `${this.testResult.name}\nStatus: ${this.testResult.status}`;
    
    if (this.testResult.gasUsed) {
      tooltip += `\nGas Used: ${this.testResult.gasUsed.toLocaleString()}`;
    }
    
    if (this.testResult.duration !== undefined) {
      tooltip += `\nDuration: ${this.testResult.duration < 1 ? '<1ms' : `${this.testResult.duration}ms`}`;
    }
    
    if (this.testResult.error) {
      tooltip += `\nError: ${this.testResult.error}`;
    }
    
    return tooltip;
  }
}

export function activate(context: vscode.ExtensionContext) {
  const workspaceRoot = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
    ? vscode.workspace.workspaceFolders[0].uri.fsPath : '';

  if (!workspaceRoot) {
    return;
  }

  // Check if this is a Foundry project
  const foundryConfigExists = vscode.workspace.findFiles('**/foundry.toml', null, 1);
  const forgeConfigExists = vscode.workspace.findFiles('**/forge.toml', null, 1);
  
  Promise.all([foundryConfigExists, forgeConfigExists]).then(([foundry, forge]) => {
    if (foundry.length > 0 || forge.length > 0) {
      vscode.commands.executeCommand('setContext', 'foundryProject', true);
    }
  });

  const provider = new FoundryTestProvider(workspaceRoot);
  vscode.window.registerTreeDataProvider('forgeDefender', provider);

  // Register commands
  const runAllTestsCommand = vscode.commands.registerCommand('forgeDefender.runAllTests', () => {
    provider.runAllTests();
  });

  const runTestCommand = vscode.commands.registerCommand('forgeDefender.runTest', (testItem: TestItem) => {
    if (testItem.testResult && testItem.contractName) {
      provider.runSingleTest(testItem.contractName, testItem.testResult.name);
    }
  });

  const refreshTestsCommand = vscode.commands.registerCommand('forgeDefender.refreshTests', () => {
    provider.refresh();
  });

  const showTestOutputCommand = vscode.commands.registerCommand('forgeDefender.showTestOutput', (testItem: TestItem) => {
    if (testItem.testResult && testItem.contractName) {
      provider.showTestOutput(testItem.contractName, testItem.testResult.name);
    }
  });

  // Auto-refresh tests when Solidity files change
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.sol');
  watcher.onDidChange(() => provider.refresh());

  // Initial test discovery
  provider.refresh();

  context.subscriptions.push(
    runAllTestsCommand,
    runTestCommand,
    refreshTestsCommand,
    showTestOutputCommand,
    watcher
  );
}

export function deactivate() {}