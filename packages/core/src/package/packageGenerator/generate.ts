import { SfProject, SfProjectJson } from '@salesforce/core';
import { ensureArray } from '@salesforce/ts-types';
import SFPLogger, {
    LoggerLevel,
    COLOR_KEY_VALUE,
    COLOR_KEY_MESSAGE,
    COLOR_HEADER,
    COLOR_TRACE,
    COLOR_ERROR,
    COLOR_INFO,
} from '@dxatscale/sfp-logger';
import SFPOrg from '../../org/SFPOrg';

import { NamedPackageDirLarge, PackageCharacter } from './types';
import GitTags from './tags.js';
import DependencyCheck from './dependency-check.js';
import { SfPowerscriptsEvent__c } from '../../eventStream/types';
import { Schema } from 'jsforce';
import axios from 'axios';
import 'dotenv/config';

axios.defaults.baseURL = process.env.GITLAB_JOB_URL;
axios.defaults.headers.common['Authorization'] = process.env.GITLAB_TOKEN;

import ValidateDiff from './validate.js';
export class BuildGeneration {
    private devHubAlias: string;
    private branch: string;
    constructor(devHubAlias: string, branch: string) {
        this.devHubAlias = devHubAlias;
        this.branch = branch;
    }
    public async run(includeOnlyPackages: string[]): Promise<Map<string, PackageCharacter>> {
        SFPLogger.log(
            COLOR_HEADER(
                '1️⃣  Loop sfdx-project.json package trees to search for modified files or package tree changes in git...'
            ),
            LoggerLevel.INFO
        );

        // get sfdx project.json
        const project = await SfProject.resolve();
        const projectJson: SfProjectJson = await project.retrieveSfProjectJson();
        const { packageAliases } = projectJson.getContents();
        const packageMap = new Map<string, PackageCharacter>();

        // first get all tags from the current branch

        const gitTags = new GitTags();
        const dependencyCheck = new DependencyCheck();
        const tagMap = await gitTags.getTagsFromCurrentBranch();

        // get all packages
        const contents = projectJson.getContents();

        const packageDirs: NamedPackageDirLarge[] = ensureArray(contents.packageDirectories);
        // create yaml files templates

        // first loop for changes detection
        const promises: Promise<void>[] = [];
        for (const pck of packageDirs) {
            if (pck.ignoreOnStage && Array.isArray(pck.ignoreOnStage) && pck.ignoreOnStage.includes('build')) {
                SFPLogger.log(
                    COLOR_TRACE(`👆 Package ${pck.package} is ignored on build stage. Skipping...`),
                    LoggerLevel.INFO
                );
                continue;
            }

            if (includeOnlyPackages.length > 0 && !includeOnlyPackages.includes(pck.package!)) {
                continue;
            }

            const promise = checkPackageChangesWithTag(pck, packageAliases, packageMap, projectJson, tagMap);

            promises.push(promise);
        }

        await Promise.allSettled(promises);

        await dependencyCheck.run(tagMap, packageMap);

        await getCommitsFromDevHub(this.devHubAlias, this.branch, packageMap);

        SFPLogger.log(
            COLOR_HEADER(
                '2️⃣  Fetch all unlocked package commits from devhub and check if there are changes between the last commit and the head of the branch...'
            )
        );

        const promises2: Promise<void>[] = [];
        const packagesToDeleteMap = new Map<string, string>();
        for (const pck of packageDirs) {
            if (
                packageMap.has(pck.package!) &&
                packageMap.get(pck.package!).type === 'unlocked' &&
                packageMap.get(pck.package!).devHubEventInfo.commitId &&
                packageMap.get(pck.package!).devHubEventInfo.jobId
            ) {
                const promise = checkPackageChangesWithCommit(
                    pck,
                    packageMap.get(pck.package!).devHubEventInfo.commitId,
                    packageMap.get(pck.package!),
                    projectJson
                );
                promises2.push(promise);
            }
        }

        await Promise.all(promises2);

        for (const [packageName, packageCharacter] of packageMap) {
            if (packageCharacter.devHubEventInfo.isSkipped) {
                packagesToDeleteMap.set(packageName, packageName);
                continue;
            }
            for (const buildDep of packageCharacter.buildDeps) {
                if (packageMap.has(buildDep) && packageMap.get(buildDep).devHubEventInfo.isSkipped) {
                    packagesToDeleteMap.set(buildDep, buildDep);
                    SFPLogger.log(
                        COLOR_KEY_MESSAGE(
                            `⚠️ Found changes in previous job. Skipping build job for unlocked package 👇`
                        ),
                        LoggerLevel.INFO
                    );
                    SFPLogger.log(
                        `${COLOR_KEY_MESSAGE('Package Name:')} ${COLOR_KEY_VALUE(packageName)}`,
                        LoggerLevel.INFO
                    );
                    SFPLogger.log(
                        `${COLOR_KEY_MESSAGE('Job Id:')} ${COLOR_KEY_VALUE(packageCharacter.devHubEventInfo.jobId)}`,
                        LoggerLevel.INFO
                    );
                    SFPLogger.log(
                        `${COLOR_KEY_MESSAGE('Commit Id:')} ${COLOR_KEY_VALUE(
                            packageMap.get(buildDep).devHubEventInfo.commitId
                        )}`,
                        LoggerLevel.INFO
                    );
                    SFPLogger.log(
                        `${COLOR_KEY_MESSAGE('Reason:')} ${COLOR_KEY_VALUE(
                            'Dependend package was skipped. So we need to skip this package too.'
                        )}`,
                        LoggerLevel.INFO
                    );
                    SFPLogger.log(
                        `${COLOR_KEY_MESSAGE('Dependend package:')} ${COLOR_KEY_VALUE(buildDep)}`,
                        LoggerLevel.INFO
                    );
                    packageCharacter.devHubEventInfo.isSkipped = true;
                }
            }
        }

        // now delete all skipped packages
        for (const packageName of packagesToDeleteMap.keys()) {
            packageMap.delete(packageName);
        }

        return packageMap;
    }
}

async function getCommitsFromDevHub(
    devHubAlias: string,
    branch: string,
    packageMap: Map<string, PackageCharacter>
): Promise<void> {
    const query = `select Id, OwnerId, IsDeleted, Name, CreatedDate,  Branch__c, Command__c, Commit__c, ErrorMessage__c, EventId__c, EventName__c,  JobId__c, JobTimestamp__c, Package__c  from SfPowerscriptsEvent__c where Command__c = 'sfpowerscript:orchestrator:build' and Branch__c = '${branch}' order by CreatedDate desc`;
    if (!devHubAlias || !branch) {
        return;
    }
    let devhubOrg = await SFPOrg.create({ aliasOrUsername: devHubAlias });
    let connection = devhubOrg.getConnection();
    let devHubCommitResponse = await connection.autoFetchQuery<SfPowerscriptsEvent__c & Schema>(query);
    let devHubEventList = devHubCommitResponse.records ? devHubCommitResponse.records : [];
    for (const event of devHubEventList) {
        if (packageMap.has(event.Package__c) && !packageMap.get(event.Package__c).devHubEventInfo.jobId) {
            packageMap.get(event.Package__c).devHubEventInfo = {
                commitId: event.Commit__c,
                eventName: event.EventName__c,
                jobId: event.JobId__c,
                branch: event.Branch__c,
                errorMessage: event.ErrorMessage__c,
                isSkipped: false,
            };
        }
    }
}

async function checkPackageChangesWithTag(
    pck: NamedPackageDirLarge,
    packageAliases: { [k: string]: string } | undefined,
    packageMap: Map<string, PackageCharacter>,
    projectJson: SfProjectJson,
    tagMap: Map<string, string[]>
): Promise<void> {
    const packageCharacter: PackageCharacter = {
        hasDepsChanges: false,
        hasManagedPckDeps: false,
        reason: '',
        type: '',
        versionNumber: '',
        packageDeps: [],
        packageId: '',
        path: pck.path,
        buildDeps: [],
        hasError: false,
        errorMessages: '',
        subscriberPackageId: '',
        devHubEventInfo: { commitId: '', eventName: '', jobId: '', branch: '', errorMessage: '', isSkipped: false },
    };
    if (pck.ignoreOnStage && Array.isArray(pck.ignoreOnStage) && pck.ignoreOnStage.includes('build')) {
        return;
    }

    // set version
    packageCharacter.versionNumber = pck.versionNumber ?? '';
    packageCharacter.packageId = packageAliases![pck.package!] ? packageAliases![pck.package!] : '';
    // check bit2win dependencies
    if (pck.dependencies && Array.isArray(pck.dependencies)) {
        for (const packageTreeDeps of pck.dependencies!) {
            if (packageAliases![packageTreeDeps.package] && packageAliases![packageTreeDeps.package].startsWith('04')) {
                packageCharacter.hasManagedPckDeps = true;
            } else {
                packageCharacter.packageDeps.push(packageTreeDeps);
            }
        }
    }

    // check pck type
    if (pck.type ?? pck.type === 'data') {
        packageCharacter.type = 'data';
    } else if (packageAliases![pck.package!]) {
        packageCharacter.type = 'unlocked';
    } else {
        packageCharacter.type = 'source';
    }

    const gitTag = await ValidateDiff.getInstance().getLatestTag(pck.package!, tagMap);
    if (!gitTag) {
        packageCharacter.reason = 'No Tag/Version Found';
        packageMap.set(pck.package!, packageCharacter);
        return;
    }

    const hasGitDiff = await ValidateDiff.getInstance().getGitDiff(gitTag, pck, projectJson);
    if (hasGitDiff) {
        packageCharacter.reason = 'Found change(s) in package';
        packageCharacter.tag = gitTag;
        const hasPackageDepsChanges = await ValidateDiff.getInstance().getPackageTreeChanges(
            gitTag,
            pck,
            projectJson,
            true
        );
        packageCharacter.hasDepsChanges = hasPackageDepsChanges;
        packageMap.set(pck.package!, packageCharacter);
        return;
    }

    const hasPackageTreeChanges = await ValidateDiff.getInstance().getPackageTreeChanges(gitTag, pck, projectJson);
    if (hasPackageTreeChanges) {
        packageCharacter.reason = 'Package Descriptor Changed';
        packageCharacter.tag = gitTag;
        const hasPackageDepsChanges = await ValidateDiff.getInstance().getPackageTreeChanges(
            gitTag,
            pck,
            projectJson,
            true
        );
        packageCharacter.hasDepsChanges = hasPackageDepsChanges;
        packageMap.set(pck.package!, packageCharacter);
    }
}

async function checkPackageChangesWithCommit(
    pck: NamedPackageDirLarge,
    commitId: string,
    packageCharacter: PackageCharacter,
    projectJson: SfProjectJson
): Promise<void> {
    const hasGitDiff = await ValidateDiff.getInstance().getGitDiff(commitId, pck, projectJson);

    const hasPackageTreeChanges = await ValidateDiff.getInstance().getPackageTreeChanges(commitId, pck, projectJson);

    const hasPackageDepsChanges = await ValidateDiff.getInstance().getPackageTreeChanges(
        commitId,
        pck,
        projectJson,
        true
    );

    let isGitJobActive = false;

    try {
        const jobResponse = await axios({
            method: 'get',
            url: `/${packageCharacter.devHubEventInfo.jobId}`,
        });
        if (jobResponse.status === 200 && jobResponse.data) {
            SFPLogger.log(
                COLOR_INFO(`Found gitlab job id ${packageCharacter.devHubEventInfo.jobId} with status ${jobResponse.data.status}`),
                LoggerLevel.TRACE
            );
            if (jobResponse.data.status === 'running') {
                isGitJobActive = true;
            }   
        }
    } catch (e) {
        SFPLogger.log(
            COLOR_ERROR(`💥 Found no gitlab job with id ${packageCharacter.devHubEventInfo.jobId}`),
            LoggerLevel.TRACE
        );
    }

    if (packageCharacter.devHubEventInfo.eventName === 'sfpowerscripts.build.success') {
        if (!hasGitDiff && !hasPackageTreeChanges && !hasPackageDepsChanges) {
            SFPLogger.log(
                COLOR_KEY_MESSAGE(`✅ Found no git diffs from previous job. So we can skip the build job 👇`),
                LoggerLevel.INFO
            );
            SFPLogger.log(`${COLOR_KEY_MESSAGE('Package Name:')} ${pck.package}`, LoggerLevel.INFO);
            SFPLogger.log(
                `${COLOR_KEY_MESSAGE('Job Id:')} ${packageCharacter.devHubEventInfo.jobId}`,
                LoggerLevel.INFO
            );
            SFPLogger.log(`${COLOR_KEY_MESSAGE('Commit Id:')} ${commitId}`, LoggerLevel.INFO);
            SFPLogger.log(
                `${COLOR_KEY_MESSAGE('Reason:')} ${
                    'Previous build job for this package still in progress. Found no changes for new job ✅'
                }`,
                LoggerLevel.INFO
            );
            packageCharacter.devHubEventInfo.isSkipped = true;
        }
    } else if (packageCharacter.devHubEventInfo.eventName === 'sfpowerscripts.build.failed') {
        if (
            !hasGitDiff &&
            !hasPackageTreeChanges &&
            !hasPackageDepsChanges &&
             packageCharacter.devHubEventInfo.errorMessage?.includes('Unlocked package creation errors')
        ) {
            SFPLogger.log(
                COLOR_ERROR(`💥 Found no git diffs from previous job. So first fix the error from previous job👇`),
                LoggerLevel.INFO
            );
            SFPLogger.log(`${COLOR_KEY_MESSAGE('Package Name:')} ${pck.package}`, LoggerLevel.INFO);
            SFPLogger.log(
                `${COLOR_KEY_MESSAGE('Job Id:')} ${packageCharacter.devHubEventInfo.jobId}`,
                LoggerLevel.INFO
            );
            SFPLogger.log(`${COLOR_KEY_MESSAGE('Commit Id:')} ${commitId}`, LoggerLevel.INFO);
            SFPLogger.log(
                `${COLOR_KEY_MESSAGE('Reason:')} ${packageCharacter.devHubEventInfo.errorMessage}`,
                LoggerLevel.INFO
            );
            packageCharacter.devHubEventInfo.isSkipped = true;
        }
    } else {
        // progress or awaiting new logic in future
        // check make only sense when no gitlab job is active , important when a job is skipped for example
        if (isGitJobActive) {
            if (hasGitDiff || hasPackageTreeChanges || hasPackageDepsChanges) {
                SFPLogger.log(
                    COLOR_KEY_MESSAGE(`⚠️ Found changes in previous job. Skipping build job for unlocked package 👇`),
                    LoggerLevel.INFO
                );
                SFPLogger.log(
                    `${COLOR_KEY_MESSAGE('Package Name:')} ${pck.package}`,
                    LoggerLevel.INFO
                );
                SFPLogger.log(
                    `${COLOR_KEY_MESSAGE('Job Id:')} ${packageCharacter.devHubEventInfo.jobId}`,
                    LoggerLevel.INFO
                );
                SFPLogger.log(`${COLOR_KEY_MESSAGE('Commit Id:')} ${commitId}`, LoggerLevel.INFO);
                SFPLogger.log(
                    `${COLOR_KEY_MESSAGE('Reason:')} ${
                        'Previous build job for this package still in progress. We need to use the next job for this package'
                    }`,
                    LoggerLevel.INFO
                );
                packageCharacter.devHubEventInfo.isSkipped = true;
            } else {
                SFPLogger.log(
                    COLOR_KEY_MESSAGE(`✅ Found no git diffs from previous job. So we can skip the build job 👇`),
                    LoggerLevel.INFO
                );
                SFPLogger.log(
                    `${COLOR_KEY_MESSAGE('Package Name:')} ${pck.package}`,
                    LoggerLevel.INFO
                );
                SFPLogger.log(
                    `${COLOR_KEY_MESSAGE('Job Id:')} ${packageCharacter.devHubEventInfo.jobId}`,
                    LoggerLevel.INFO
                );
                SFPLogger.log(`${COLOR_KEY_MESSAGE('Commit Id:')} ${commitId}`, LoggerLevel.INFO);
                SFPLogger.log(
                    `${COLOR_KEY_MESSAGE('Reason:')} ${
                        'Previous build job for this package still in progress. Found no changes for new job ✅'
                    }`,
                    LoggerLevel.INFO
                );
                packageCharacter.devHubEventInfo.isSkipped = true;
            }
        }
    }
}
