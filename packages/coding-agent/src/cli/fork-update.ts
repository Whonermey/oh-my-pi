/**
 * Fork-source update flow.
 *
 * When this binary was built from a fork clone (a `.fork` marker file sits
 * next to the executable), `omp update` does NOT install the official
 * release. Instead it merges `upstream/main` into the fork branch, rebuilds
 * the binary from source, and self-replaces via the Windows-safe rename
 * trick (renaming the running image is permitted; only deleting it is not).
 *
 * Upstream version notifications are untouched: the rebuilt binary reports
 * the merged upstream version (`packages/utils/package.json`), so the npm
 * registry comparison in {@link checkForNewVersion} keeps nudging exactly
 * when upstream publishes something newer than the installed base.
 *
 * Marker file (`<executable>.fork`), one `key=value` per line:
 *   repo=C:\path\to\fork-clone
 *   branch=models-profiles
 *
 * To return to the official distribution, delete the marker file and run
 * `omp update` once: the fork build then falls through to the stock update
 * flow and the official release replaces this binary.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";

export interface ForkMarker {
	repo: string;
	branch: string;
}

/** Marker file path: sits next to the running executable so it survives self-replacement. */
export function forkMarkerPath(execPath: string = process.execPath): string {
	return `${execPath}.fork`;
}

/** Parse `<executable>.fork`; undefined when absent or malformed (stock install). */
export function readForkMarker(execPath: string = process.execPath): ForkMarker | undefined {
	let raw: string;
	try {
		raw = fs.readFileSync(forkMarkerPath(execPath), "utf8");
	} catch {
		return undefined;
	}
	const fields: Record<string, string> = {};
	for (const line of raw.split(/\r?\n/)) {
		const eq = line.indexOf("=");
		if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
	}
	const repo = fields.repo;
	const branch = fields.branch;
	if (!repo || !branch || !fs.existsSync(path.join(repo, ".git"))) return undefined;
	return { repo, branch };
}

/** Exit code of a foreground child with inherited stdio (user sees git/bun output). */
async function runForeground(command: string, args: string[], cwd: string): Promise<number> {
	const proc = Bun.spawn([command, ...args], {
		cwd,
		stdio: ["inherit", "inherit", "inherit"],
	});
	return await proc.exited;
}

/** Commit count on `upstream/main` not present in HEAD. */
async function upstreamAheadCount(repo: string): Promise<number> {
	const proc = Bun.spawn(["git", "-C", repo, "rev-list", "--count", "HEAD..upstream/main"], {
		cwd: repo,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const output = await new Response(proc.stdout).text();
	const exitCode = await proc.exited;
	if (exitCode !== 0) throw new Error("git rev-list failed — is the upstream remote configured?");
	return Number.parseInt(output.trim(), 10) || 0;
}

/** Whether the working tree is clean (a merge requires it). */
async function workingTreeClean(repo: string): Promise<boolean> {
	const proc = Bun.spawn(["git", "-C", repo, "status", "--porcelain"], {
		cwd: repo,
		stdio: ["ignore", "pipe", "ignore"],
	});
	const output = await new Response(proc.stdout).text();
	await proc.exited;
	return output.trim().length === 0;
}

/**
 * Run the fork-source update. Returns true when a fork marker exists and the
 * request was handled (including error paths — the stock flow must not run).
 */
export async function runForkUpdateIfFork(options: { force: boolean; check: boolean }): Promise<boolean> {
	const marker = readForkMarker();
	if (!marker) return false;
	const { repo, branch } = marker;

	if (options.check) {
		try {
			await runForeground("git", ["-C", repo, "fetch", "upstream", "main"], repo);
			const ahead = await upstreamAheadCount(repo);
			if (ahead > 0) {
				console.log(
					chalk.cyan(
						`New upstream available: main is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${branch}. Run "omp update" to merge and rebuild.`,
					),
				);
			} else {
				console.log(chalk.green(`${"✔"} ${branch} is up to date with upstream/main`));
			}
		} catch (err) {
			console.error(chalk.red(`Failed to check fork updates: ${err}`));
			process.exitCode = 1;
		}
		return true;
	}

	try {
		if (!(await workingTreeClean(repo))) {
			console.error(chalk.red(`${repo} has uncommitted changes — commit or stash them before updating.`));
			process.exitCode = 1;
			return true;
		}
		console.log(chalk.dim("Fork install detected — merging upstream/main and rebuilding from source."));
		const fetchExit = await runForeground("git", ["-C", repo, "fetch", "upstream", "main"], repo);
		if (fetchExit !== 0) {
			console.error(chalk.red("git fetch upstream main failed."));
			process.exitCode = 1;
			return true;
		}
		const ahead = await upstreamAheadCount(repo);
		if (ahead === 0 && !options.force) {
			console.log(chalk.green(`${"✔"} ${branch} is up to date with upstream/main`));
			return true;
		}
		console.log(chalk.cyan(`Merging upstream/main (${ahead} commit${ahead === 1 ? "" : "s"}) into ${branch}…`));
		const mergeExit = await runForeground("git", ["-C", repo, "merge", "upstream/main", "--no-edit"], repo);
		if (mergeExit !== 0) {
			console.error(
				chalk.red(`Merge conflict in ${repo}. Resolve it (branch ${branch}), then run "omp update" again.`),
			);
			process.exitCode = 1;
			return true;
		}

		console.log(chalk.dim("Rebuilding…"));
		const buildExit = await runForeground("bun", ["--cwd=packages/coding-agent", "run", "build"], repo);
		if (buildExit !== 0) {
			console.error(chalk.red("Source build failed."));
			process.exitCode = 1;
			return true;
		}

		await replaceRunningBinary(repo);
		console.log(
			chalk.green(`${"✔"} Updated. Restart omp to run the new build (current session keeps the old code).`),
		);
	} catch (err) {
		console.error(chalk.red(`Fork update failed: ${err}`));
		process.exitCode = 1;
	}
	return true;
}

/**
 * Self-replace the running executable with the freshly built binary, using
 * the rename trick: the running image may be renamed (not deleted) on
 * Windows, so the old file moves aside and the new one takes its name.
 */
async function replaceRunningBinary(repo: string): Promise<void> {
	const targetPath = process.execPath;
	const newBinary = path.join(repo, "packages", "coding-agent", "dist", "omp.exe");
	if (!fs.existsSync(newBinary)) {
		throw new Error(`Built binary not found: ${newBinary}`);
	}
	const backupPath = `${targetPath}.fork-bak`;
	fs.renameSync(targetPath, backupPath);
	try {
		fs.renameSync(newBinary, targetPath);
	} catch (err) {
		// Restore the previous binary before rethrowing.
		try {
			fs.renameSync(backupPath, targetPath);
		} catch {
			// The backup is the last copy; surface the original failure.
		}
		throw err;
	}
	// The backup may still be the running image of a previous session; a
	// failed removal must not fail the update.
	try {
		fs.unlinkSync(backupPath);
	} catch {
		// Leftover cleanup happens on the next successful update.
	}
}
