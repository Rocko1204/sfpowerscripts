import BatchingTopoSort from './BatchingTopoSort';
import DependencyHelper from './DependencyHelper';
import Bottleneck from 'bottleneck';
import PackageDiffImpl, { PackageDiffOptions } from '@dxatscale/sfpowerscripts.core/lib/package/diff/PackageDiffImpl';
import { EOL } from 'os';
import SFPStatsSender from '@dxatscale/sfpowerscripts.core/lib/stats/SFPStatsSender';
import { Stage } from '../Stage';
import * as fs from 'fs-extra';
import ProjectConfig from '@dxatscale/sfpowerscripts.core/lib/project/ProjectConfig';
import BuildCollections from './BuildCollections';
const Table = require('cli-table');
import SFPLogger, {
    COLOR_KEY_VALUE,
    COLOR_TRACE,
    COLOR_INFO,
    ConsoleLogger,
    FileLogger,
    LoggerLevel,
    VoidLogger,
} from '@dxatscale/sfp-logger';
import { COLOR_KEY_MESSAGE } from '@dxatscale/sfp-logger';
import { COLOR_HEADER } from '@dxatscale/sfp-logger';
import { COLOR_ERROR } from '@dxatscale/sfp-logger';
import SfpPackage, { PackageType } from '@dxatscale/sfpowerscripts.core/lib/package/SfpPackage';
import SfpPackageBuilder from '@dxatscale/sfpowerscripts.core/lib/package/SfpPackageBuilder';
import getFormattedTime from '@dxatscale/sfpowerscripts.core/lib/utils/GetFormattedTime';
import { COLON_MIDDLE_BORDER_TABLE, ZERO_BORDER_TABLE } from '../../ui/TableConstants';
import PackageDependencyResolver from '@dxatscale/sfpowerscripts.core/lib/package/dependencies/PackageDependencyResolver';
import SFPOrg, { PackageTypeInfo } from '@dxatscale/sfpowerscripts.core/lib/org/SFPOrg';
import Git from '@dxatscale/sfpowerscripts.core/lib/git/Git';
import TransitiveDependencyResolver from '@dxatscale/sfpowerscripts.core/lib/package/dependencies/TransitiveDependencyResolver';
import GroupConsoleLogs from '../../ui/GroupConsoleLogs';
import UserDefinedExternalDependency from '@dxatscale/sfpowerscripts.core/lib/project/UserDefinedExternalDependency';
import PackageDependencyDisplayer from '@dxatscale/sfpowerscripts.core/lib/display/PackageDependencyDisplayer';
import { BuildGeneration } from '@dxatscale/sfpowerscripts.core/lib/package/packageGenerator/generate';
import { PackageCharacter } from '@dxatscale/sfpowerscripts.core/lib/package/packageGenerator/types';
import { Lifecycle } from '@salesforce/core';
import { PackageVersionCreateReportProgress, PackageVersionEvents } from '@salesforce/packaging';
import PackageVersionCoverage from '@dxatscale/sfpowerscripts.core/lib/package/coverage/PackageVersionCoverage';
import { delay } from '@dxatscale/sfpowerscripts.core/lib/utils/Delay';
import { Connection } from '@salesforce/core';
import { Schema } from 'jsforce';
import pQueue from 'p-queue';
import { BuildStreamService } from '@dxatscale/sfpowerscripts.core/lib/eventStream/build';
import Promote from '../../commands/orchestrator/publish';
import ArtifactGenerator from '@dxatscale/sfpowerscripts.core/lib/artifacts/generators/ArtifactGenerator';

const PRIORITY_UNLOCKED_PKG_WITH_DEPENDENCY = 1;
const PRIORITY_UNLOCKED_PKG_WITHOUT_DEPENDENCY = 3;
const PRIORITY_SOURCE_PKG = 5;
const PRIORITY_DATA_PKG = 5;

export interface BuildProps {
    overridePackageTypes?: { [key: string]: PackageType };
    configFilePath?: string;
    projectDirectory?: string;
    devhubAlias?: string;
    repourl?: string;
    waitTime: number;
    isQuickBuild: boolean;
    isDiffCheckEnabled: boolean;
    buildNumber: number;
    executorcount: number;
    isBuildAllAsSourcePackages: boolean;
    branch?: string;
    jobId?: string; //eventStream
    artifactdir?: string; // build/publish
    currentStage: Stage;
    baseBranch?: string;
    diffOptions?: PackageDiffOptions;
    includeOnlyPackages?: string[];
}
export default class BuildImplEvents {
    private limiter: Bottleneck;
    private parentsToBeFulfilled;
    private childs;
    private packagesToBeBuilt: string[];
    private packageCreationPromises: Array<Promise<SfpPackage>>;
    private projectConfig;
    private parents: any;
    private packagesInQueue: string[] = [];
    private packagesBuilt: string[];
    private failedPackages: string[];
    private generatedPackages: SfpPackage[];
    private sfpOrg: SFPOrg;
    private scratchOrgDefinitions: { [key: string]: any }[];
    private isMultiConfigFilesEnabled: boolean;
    private packageTypeInfos: PackageTypeInfo[];
    private repository_url: string;
    private commit_id: string;

    private logger = new ConsoleLogger();
    private recursiveAll = (a) => Promise.all(a).then((r) => (r.length == a.length ? r : this.recursiveAll(a)));

    public constructor(private props: BuildProps) {
        this.limiter = new Bottleneck({
            maxConcurrent: this.props.executorcount,
        });

        this.packagesBuilt = [];
        this.failedPackages = [];
        this.generatedPackages = [];
        this.packageCreationPromises = new Array();
    }

    public async exec(): Promise<{
        generatedPackages: SfpPackage[];
        failedPackages: string[];
    }> {
        if (this.props.devhubAlias)
            this.sfpOrg = await SFPOrg.create({
                aliasOrUsername: this.props.devhubAlias,
            });
        /*************************************************************************************************************************************************
      First get all packages in the repo, then filter packages based on release definition and project json settings
    *************************************************************************************************************************************************/
        let git = await Git.initiateRepo(new ConsoleLogger());
        this.repository_url = await git.getRemoteOriginUrl(this.props.repourl);
        this.commit_id = await git.getHeadCommit();
        BuildStreamService.buildProps(this.props);
        BuildStreamService.buildJobAndOrgId(this.props.jobId, this.sfpOrg?.getConnection().getAuthInfoFields().instanceUrl,this.props.devhubAlias,this.commit_id);

        this.packagesToBeBuilt = this.getPackagesToBeBuilt(this.props.projectDirectory, this.props.includeOnlyPackages);

        // Read Manifest
        this.projectConfig = ProjectConfig.getSFDXProjectConfig(this.props.projectDirectory);

        //Build Scratch Org Def Files Map
        this.scratchOrgDefinitions = this.getMultiScratchOrgDefinitionFileMap(this.projectConfig);

        this.packageTypeInfos = await this.sfpOrg.listAllPackages();

        const q = new pQueue({ concurrency: this.props.executorcount });

        //Do a diff Impl
        let table;
        let packageCharacterMap = new Map<string, PackageCharacter>();
       /*************************************************************************************************************************************************
        Check if diff check is enabled, if so, then filter packages to be built based on the diff check
       *************************************************************************************************************************************************/
        if (this.props.isDiffCheckEnabled) {
            const buildGeneration = new BuildGeneration(this.props.devhubAlias, this.props.branch);
            packageCharacterMap = await buildGeneration.run(this.packagesToBeBuilt);
            table = this.createDiffPackageScheduledDisplayedAsATable(packageCharacterMap);
            this.packagesToBeBuilt = Array.from(packageCharacterMap.keys()); //Assign it back to the instance variable
        } else {
            table = this.createAllPackageScheduledDisplayedAsATable();
        }

        //Log Packages to be built
        SFPLogger.log(COLOR_KEY_MESSAGE('Packages scheduled for build'));
        SFPLogger.log(table.toString());

        //Fix transitive dependency gap
        SFPLogger.log(
            COLOR_TRACE(
                'Resolving dependencies from project config'
            ),
            LoggerLevel.INFO
        );
        this.projectConfig = await this.resolvePackageDependencies(this.projectConfig);
 

        SFPLogger.log(
            COLOR_TRACE(
                'Building Packages'
            ),
            LoggerLevel.INFO
        );

        for await (const pkg of this.packagesToBeBuilt) {
            let type = this.getPriorityandTypeOfAPackage(this.projectConfig, pkg).type;
            SFPStatsSender.logCount('build.scheduled.packages', {
                package: pkg,
                type: type,
                is_diffcheck_enabled: String(this.props.isDiffCheckEnabled),
                is_dependency_validated: this.props.isQuickBuild ? 'false' : 'true',
                pr_mode: String(this.props.isBuildAllAsSourcePackages),
            });
        }

        if (this.packagesToBeBuilt.length == 0){
            return {
                generatedPackages: this.generatedPackages,
                failedPackages: this.failedPackages,
            };
        }

        /*************************************************************************************************************************************************
         This part builds all packages from the repo because the flag isDiffCheckEnabled is false
        *************************************************************************************************************************************************/
        if (!this.props.isDiffCheckEnabled) {
            SFPLogger.log(
                COLOR_HEADER(
                    '3️⃣  Build all packages without validation...'
                ),
                LoggerLevel.INFO
            );
            if (!this.props.isQuickBuild && this.sfpOrg) {
                const packageDependencyResolver = new PackageDependencyResolver(
                    this.sfpOrg.getConnection(),
                    this.projectConfig,
                    this.packagesToBeBuilt
                );
                this.projectConfig = await packageDependencyResolver.resolvePackageDependencyVersions();
            }

            for (const pkg of this.packagesToBeBuilt) {
                SFPLogger.log(COLOR_KEY_MESSAGE(`📦 Package creation initiated for 👉 ${pkg}`));
                BuildStreamService.buildPackageStatus(pkg,'inprogress');
                let type = this.getPriorityandTypeOfAPackage(this.projectConfig, pkg).type;
                q.add(() =>
                    this.createPackage(type, pkg, this.props.isBuildAllAsSourcePackages)
                        .then(async (sfpPackage) => {
                            this.generatedPackages.push(sfpPackage);
                            this.printPackageDetails(sfpPackage);
                            await ArtifactGenerator.generateArtifact(sfpPackage, process.cwd(), this.props.artifactdir)
                            await Promote.getInstance().promote(pkg, this.props.artifactdir)
                            SFPStatsSender.logCount('build.succeeded.packages', {
                                package: pkg,
                                type: type,
                                is_diffcheck_enabled: String(this.props.isDiffCheckEnabled),
                                is_dependency_validated: this.props.isQuickBuild ? 'false' : 'true',
                                pr_mode: String(this.props.isBuildAllAsSourcePackages),
                            });
                        })
                        .catch((error) => {
                            this.handlePackageError(error.reason, pkg);
                        })
                );
            }

            await q.onIdle();
            SFPLogger.log('Finished loading all packages');
            return {
                generatedPackages: this.generatedPackages,
                failedPackages: this.failedPackages,
            };
        }

        /*************************************************************************************************************************************************
         This part builds all packages with diff check enabled
        *************************************************************************************************************************************************/
        
        /*************************************************************************************************************************************************
         First build source and data packages
        *************************************************************************************************************************************************/
         SFPLogger.log(
            COLOR_HEADER(
                '3️⃣  Build all source/data/diff packages where changes were found in the git diff check...'
            ),
            LoggerLevel.INFO
         );
        // create initial build lists
        for (const [packageName, packageCharacter] of packageCharacterMap) {
            if (packageCharacter.hasError && !this.failedPackages.includes(packageName)) {
                this.handlePackageError(packageCharacter.errorMessages, packageName);
            }
            //fill source package creation promises
            if (
                (packageCharacter.type === 'source' ||
                    packageCharacter.type === 'data' ||
                    packageCharacter.type === 'diff') &&
                !packageCharacter.hasError
            ) {
                
                SFPLogger.log(COLOR_KEY_MESSAGE(`📦 Package creation initiated for 👉 ${packageName}`));
                BuildStreamService.buildPackageStatus(packageName,'inprogress');
                q.add(() =>
                    this.createPackage(packageCharacter.type, packageName, this.props.isBuildAllAsSourcePackages)
                        .then(async (sfpPackage) => {
                            this.generatedPackages.push(sfpPackage);
                            this.printPackageDetails(sfpPackage);
                            await ArtifactGenerator.generateArtifact(sfpPackage, process.cwd(), this.props.artifactdir)
                            await Promote.getInstance().promote(packageName, this.props.artifactdir)
                            SFPStatsSender.logCount('build.succeeded.packages', {
                                package: packageName,
                                type: packageCharacter.type,
                                is_diffcheck_enabled: String(this.props.isDiffCheckEnabled),
                                is_dependency_validated: this.props.isQuickBuild ? 'false' : 'true',
                                pr_mode: String(this.props.isBuildAllAsSourcePackages),
                            });
                        })
                        .catch((error) => {
                            this.handlePackageError(error.reason, packageName);
                            packageCharacter.hasError = true;
                            packageCharacter.errorMessages = error?.reason;
                        })
                );
            }
        }

        /*************************************************************************************************************************************************
         Now build all unlocked packages with dependencies, fill the queue and listen to the lifecycle events from @salesforce/packaging
        *************************************************************************************************************************************************/
         SFPLogger.log(
            COLOR_HEADER(
                '4️⃣  Build all unlocked packages where changes were found in the git diff check with validation flag enabeled...'
            ),
            LoggerLevel.INFO
         );
        for (const [packageName, packageCharacter] of packageCharacterMap) {
            // check if the deps package has error , then the main will not be created and the main get the error message from deps
            if (packageCharacter.type === 'unlocked' && packageCharacter.hasError) {
                if (!this.failedPackages.includes(packageName)) {
                    this.handlePackageError(packageCharacter.errorMessages, packageName);
                }
                this.removeUnlockedPckFromQueue(packageName, packageCharacter.errorMessages, packageCharacterMap);
            }

            if (
                packageCharacter.type === 'unlocked' &&
                !packageCharacter.hasError &&
                packageCharacter.buildDeps.length > 0
            ) {
                SFPLogger.log(
                    COLOR_INFO(
                        `⏳ Put package ${packageName} in queue because it needs to wait for this dependecies: ${packageCharacter.buildDeps.toString()}`
                    ),
                    LoggerLevel.INFO
                );
            }

            if (
                packageCharacter.type === 'unlocked' &&
                !packageCharacter.hasError &&
                packageCharacter.buildDeps.length === 0
            ) {
                SFPLogger.log(COLOR_KEY_MESSAGE(`📦 Package creation initiated for 👉 ${packageName}`));
                BuildStreamService.buildPackageStatus(packageName,'inprogress');
                q.add(() =>
                    this.createPackage(packageCharacter.type, packageName, this.props.isBuildAllAsSourcePackages)
                        .then(async (sfpPackage) => {
                            if (sfpPackage.package_version_id) {
                                packageCharacter.subscriberPackageId = sfpPackage.package_version_id;
                                    if (!sfpPackage.has_passed_coverage_check) {
                                        packageCharacter.hasError = true;
                                        packageCharacter.errorMessages =
                                            'This package has not meet the minimum coverage requirement of 75%';
                                        this.handlePackageError(
                                            'This package has not meet the minimum coverage requirement of 75%',
                                            packageName
                                        );
                                        this.removeUnlockedPckFromQueue(packageName, `This package has not meet the minimum coverage requirement of 75%`, packageCharacterMap);
                                    } else {
                                        this.generatedPackages.push(sfpPackage);
                                        this.printPackageDetails(sfpPackage);
                                        await ArtifactGenerator.generateArtifact(sfpPackage, process.cwd(), this.props.artifactdir)
                                        await Promote.getInstance().promote(packageName, this.props.artifactdir)
                                        SFPStatsSender.logCount('build.succeeded.packages', {
                                            package: packageName,
                                            type: packageCharacter.type,
                                            is_diffcheck_enabled: String(this.props.isDiffCheckEnabled),
                                            is_dependency_validated: this.props.isQuickBuild ? 'false' : 'true',
                                            pr_mode: String(this.props.isBuildAllAsSourcePackages),
                                        });
                                    }
                                
                            } else {
                                if(!packageCharacter.hasError){
                                packageCharacter.hasError = true;
                                packageCharacter.errorMessages = `The build for this package was not completed in the wait time 240 minutes.`;
                                this.handlePackageError(
                                    `The build for this package was not completed in the wait time 240 minutes.`,
                                    packageName
                                );
                                this.removeUnlockedPckFromQueue(packageName, `The build for this package was not completed in the wait time 240 minutes.`, packageCharacterMap);
                                }
                            }
                        })
                        .catch((error) => {
                            if(!packageCharacter.hasError){
                            packageCharacter.hasError = true;
                            packageCharacter.errorMessages = error;
                            this.handlePackageError(error, packageName);
                            this.removeUnlockedPckFromQueue(packageName, error, packageCharacterMap);
                            }
                        })
                );
            }
        }

        /*************************************************************************************************************************************************
         Listen to the lifecycle events from @salesforce/packaging for package creation is in progress. At the moment only for logger info
        *************************************************************************************************************************************************/

        Lifecycle.getInstance().on(
            PackageVersionEvents.create.progress,
            async (results: PackageVersionCreateReportProgress) => {
                const packageTypeInfo = this.packageTypeInfos.find((item) => item.Id === results.Package2Id);
                if (!packageTypeInfo.Name) {
                    throw new Error(`Unable to find package type info for package id ${results.Package2Id}`);
                }
                SFPLogger.log(
                    COLOR_TRACE(`⏳ Package ${packageTypeInfo.Name} is in progress...! Status: ${results.Status}`),
                    LoggerLevel.TRACE,
                    this.logger
                );
            }
        );

        /*************************************************************************************************************************************************
         Listen to the lifecycle events from @salesforce/packaging for package errors. Display error message and remove child packages from the queue
        *************************************************************************************************************************************************/

        Lifecycle.getInstance().on(
            PackageVersionEvents.create.error,
            async (results: PackageVersionCreateReportProgress) => {
                const packageTypeInfo = this.packageTypeInfos.find((item) => item.Id === results.Package2Id);
                if (!packageTypeInfo.Name) {
                    throw new Error(`Unable to find package type info for package id ${results.Package2Id}`);
                }
                let errorMessage = '<empty>';
                if (results?.Error?.length) {
                    errorMessage = 'Unlocked package creation errors: ';
                    for (let i = 0; i < results?.Error?.length; i++) {
                        errorMessage += `\n${i + 1}) ${results?.Error[i]}`;
                    }
                }
                this.handlePackageError(errorMessage, packageTypeInfo.Name);

                packageCharacterMap.get(packageTypeInfo.Name).hasError = true;
                packageCharacterMap.get(packageTypeInfo.Name).errorMessages = results.Error.toString();
                //now check if we have depened packages in pending state, then we can delete it from queue
                this.removeUnlockedPckFromQueue(packageTypeInfo.Name, errorMessage, packageCharacterMap);
            }
        );

         /*************************************************************************************************************************************************
         Listen to the lifecycle events from @salesforce/packaging for package success. Display succes message and add the package to the generated packages
         Then check child packages to put in build job when all deps are created
        *************************************************************************************************************************************************/

        Lifecycle.getInstance().on(
            PackageVersionEvents.create.success,
            async (results: PackageVersionCreateReportProgress) => {
                // now check if we can add a new package from thr queue to the job
                for (const [packageName, packageCharacter] of packageCharacterMap) {
                    if (
                        packageCharacter.type === 'unlocked' && results.SubscriberPackageVersionId && results.HasPassedCodeCoverageCheck &&
                        !packageCharacter.hasError &&
                        packageCharacter.buildDeps.includes(results.Package2Name)
                    ) {
                        // found a dependend package which is now finished
                        const index = packageCharacter.buildDeps.indexOf(results.Package2Name);
                        if (index > -1) {
                            // so we can remove the depenendency
                            packageCharacter.buildDeps.splice(index, 1);
                        }
                        if (packageCharacter.buildDeps.length === 0) {
                            // no deps left, so we can create the package
                            SFPLogger.log(COLOR_KEY_MESSAGE(`📦 Package creation initiated for 👉 ${packageName}`));
                            BuildStreamService.buildPackageStatus(packageName,'inprogress');
                            q.add(() =>
                                this.createPackage(
                                    packageCharacter.type,
                                    packageName,
                                    this.props.isBuildAllAsSourcePackages
                                )
                                    .then(async (sfpPackage) => {
                                        if (sfpPackage.package_version_id) {
                                            packageCharacter.subscriberPackageId = sfpPackage.package_version_id;
                                                if (!sfpPackage.has_passed_coverage_check) {
                                                    packageCharacter.hasError = true;
                                                    packageCharacter.errorMessages =
                                                        'This package has not meet the minimum coverage requirement of 75%';
                                                    this.handlePackageError(
                                                        'This package has not meet the minimum coverage requirement of 75%',
                                                        packageName
                                                    );
                                                    this.removeUnlockedPckFromQueue(packageName, `This package has not meet the minimum coverage requirement of 75%`, packageCharacterMap);
                                                } else {
                                                    this.generatedPackages.push(sfpPackage);
                                                    this.printPackageDetails(sfpPackage);
                                                    await ArtifactGenerator.generateArtifact(sfpPackage, process.cwd(), this.props.artifactdir)
                                                    await Promote.getInstance().promote(packageName, this.props.artifactdir)
                                                    SFPStatsSender.logCount('build.succeeded.packages', {
                                                        package: packageName,
                                                        type: packageCharacter.type,
                                                        is_diffcheck_enabled: String(this.props.isDiffCheckEnabled),
                                                        is_dependency_validated: this.props.isQuickBuild
                                                            ? 'false'
                                                            : 'true',
                                                        pr_mode: String(this.props.isBuildAllAsSourcePackages),
                                                    });
                                                }
                                            
                                        } else {
                                            packageCharacter.hasError = true;
                                            packageCharacter.errorMessages = `The build for this package was not completed in the wait time 240 minutes.`;

                                            this.handlePackageError(
                                                `The build for this package was not completed in the wait time 240 minutes.`,
                                                packageName
                                            );
                                            this.removeUnlockedPckFromQueue(packageName, `The build for this package was not completed in the wait time 240 minutes.`, packageCharacterMap);
                                        }
                                    })
                                    .catch((error) => {
                                        if(!packageCharacter.hasError){
                                        packageCharacter.hasError = true;
                                        packageCharacter.errorMessages = error;
                                        this.handlePackageError(error, packageName);
                                        this.removeUnlockedPckFromQueue(packageName, error, packageCharacterMap);
                                        }
                                    })
                            );
                        }
                    }
                }
            }
        );

        await q.onIdle();
        SFPLogger.log('Finished loading all packages');

        //###############################end new build logic ###########################################

        return {
            generatedPackages: this.generatedPackages,
            failedPackages: this.failedPackages,
        };
    }

     /*************************************************************************************************************************************************
        Helper to remove all unlocked pck from queue when a main pck runs on error
    *************************************************************************************************************************************************/

    private removeUnlockedPckFromQueue(packageName: string,errorMsg: any, packageCharacterMap: Map<string, PackageCharacter>) {
        for (const [packageNameDep, packageCharacterDep] of packageCharacterMap) {
            if (
                packageCharacterDep.type === 'unlocked' &&
                packageCharacterDep.buildDeps.includes(packageName) &&
                !packageCharacterDep.hasError
            ) {
                SFPLogger.log(
                    COLOR_TRACE(
                        `👆 Remove package ${packageNameDep} from build job because the dependend package: ${packageName} runs on error`
                    ),
                    LoggerLevel.INFO
                );
                this.handlePackageError(
                    `Dependend package with errors:/n Package: ${packageName}:\n ${errorMsg}`,
                    packageNameDep
                );
                packageCharacterMap.get(packageNameDep).hasError = true;
                packageCharacterMap.get(packageNameDep).errorMessages = errorMsg?.reason;
            }
        }
    }

    /*************************************************************************************************************************************************
        Display all package to build as a table in the command header for diff check.
    *************************************************************************************************************************************************/

    private createDiffPackageScheduledDisplayedAsATable(packagesToBeBuilt: Map<string, PackageCharacter>) {
        let tableHead = ['Package', 'Reason to be built', 'Last Known Tag'];
        if (this.isMultiConfigFilesEnabled && this.props.currentStage == Stage.BUILD) {
            tableHead.push('Scratch Org Config File');
        }
        let table = new Table({
            head: tableHead,
            chars: ZERO_BORDER_TABLE,
        });
        for (const pkg of packagesToBeBuilt.keys()) {
            let item = [
                pkg,
                packagesToBeBuilt.get(pkg).reason,
                packagesToBeBuilt.get(pkg).tag ? packagesToBeBuilt.get(pkg).tag : '',
            ];
            BuildStreamService.buildPackageInitialitation(pkg,packagesToBeBuilt.get(pkg).reason, packagesToBeBuilt.get(pkg)?.tag);
            if (this.isMultiConfigFilesEnabled && this.props.currentStage == Stage.BUILD) {
                item.push(
                    this.scratchOrgDefinitions[pkg] ? this.scratchOrgDefinitions[pkg] : this.props.configFilePath
                );
            }

            table.push(item);
        }
        return table;
    }

    /*************************************************************************************************************************************************
        Display all package to build as a table in the command header for all packages
    *************************************************************************************************************************************************/

    private createAllPackageScheduledDisplayedAsATable() {
        let tableHead = ['Package', 'Reason to be built'];
        if (this.isMultiConfigFilesEnabled && this.props.currentStage == Stage.BUILD) {
            tableHead.push('Scratch Org Config File');
        }
        let table = new Table({
            head: tableHead,
            chars: ZERO_BORDER_TABLE,
        });
        for (const pkg of this.packagesToBeBuilt) {
            let item = [pkg, 'Activated as part of all package build'];
            BuildStreamService.buildPackageInitialitation(pkg,'Activated as part of all package build','');
            if (this.isMultiConfigFilesEnabled && this.props.currentStage == Stage.BUILD) {
                item.push(
                    this.scratchOrgDefinitions[pkg] ? this.scratchOrgDefinitions[pkg] : this.props.configFilePath
                );
            }
            table.push(item);
        }
        return table;
    }

    /*************************************************************************************************************************************************
        Filter packages based on release definition and project json settings
    *************************************************************************************************************************************************/

    
    private getPackagesToBeBuilt(projectDirectory: string, includeOnlyPackages?: string[]): string[] {
        let projectConfig = ProjectConfig.getSFDXProjectConfig(projectDirectory);
        let sfdxpackages = [];

        let packageDescriptors = projectConfig['packageDirectories'].filter((pkg) => {
            if (
                pkg.ignoreOnStage?.find((stage) => {
                    stage = stage.toLowerCase();
                    return stage === this.props.currentStage;
                })
            )
                return false;
            else return true;
        });

        //Filter Packages
        if (includeOnlyPackages) {
            //Display include only packages
            printIncludeOnlyPackages();
            packageDescriptors = packageDescriptors.filter((pkg) => {
                if (
                    includeOnlyPackages.find((includedPkg) => {
                        return includedPkg == pkg.package;
                    })
                )
                    return true;
                else return false;
            });
        }

        //       Ignore aliasfied packages on  stages fix #1289
        packageDescriptors = packageDescriptors.filter((pkg) => {
            return !(this.props.currentStage === 'prepare' && pkg.aliasfy && pkg.type !== PackageType.Data);
        });

        for (const pkg of packageDescriptors) {
            if (pkg.package && pkg.versionNumber) sfdxpackages.push(pkg['package']);
        }
        return sfdxpackages;

        function printIncludeOnlyPackages() {
            SFPLogger.log(
                COLOR_KEY_MESSAGE(`Build will include the below packages as per inclusive filter`),
                LoggerLevel.TRACE
            );
            SFPLogger.log(COLOR_KEY_VALUE(`${includeOnlyPackages.toString()}`), LoggerLevel.TRACE);
        }
    }

    /*************************************************************************************************************************************************
        Write package error to the artifacts and display the message in the console
    *************************************************************************************************************************************************/

    private handlePackageError(reason: any, pkg: string): any {
        SFPLogger.printHeaderLine('', COLOR_HEADER, LoggerLevel.INFO);
        SFPLogger.log(COLOR_ERROR(`Package Creation Failed for ${pkg}, Here are the details:`));
        const sfpPackageMain:SfpPackage = {
			projectDirectory: this.props.projectDirectory, packageDirectory: pkg,
			workingDirectory: "",
			mdapiDir: "",
			destructiveChangesPath: "",
			resolvedPackageDirectory: "",
			version: "",
			packageName: "",
			versionNumber: "",
			packageType: "",
			toJSON() {
				return this;
			},
			package_name: pkg
		}; 
        try {
            // Append error to log file
            let errorMessage = typeof reason === 'string' ? reason : reason.message;

            fs.appendFileSync(`.sfpowerscripts/logs/${pkg}`, errorMessage, 'utf8');
            let data = fs.readFileSync(`.sfpowerscripts/logs/${pkg}`, 'utf8');

            const pathToMarkDownFile = `.sfpowerscripts/outputs/build-error-info.md`;
            fs.mkdirpSync('.sfpowerscripts/outputs');
            fs.createFileSync(pathToMarkDownFile);
            fs.appendFileSync(pathToMarkDownFile, `\nPlease find the errors observed during build\n\n`);
            fs.appendFileSync(pathToMarkDownFile, `## ${pkg}\n\n`);
            fs.appendFileSync(pathToMarkDownFile, data);

            SFPLogger.log(data);
            BuildStreamService.sendPackageError(sfpPackageMain,errorMessage);
            BuildStreamService.buildPackageErrorList(pkg);
        } catch (e) {
            SFPLogger.log(`Unable to display logs for pkg ${pkg}`);
            console.log(e);
        }

        //Remove myself and my  childs
        
        this.failedPackages.push(pkg);
        SFPStatsSender.logCount('build.failed.packages', { package: pkg });

        SFPLogger.printHeaderLine('', COLOR_HEADER, LoggerLevel.INFO);
    }

    
    /*************************************************************************************************************************************************
        Update dependend package version id for child packages infos /Wait for @salesforce/packaging pull request!!!!!!
    *************************************************************************************************************************************************/

    private resolveDependenciesOnCompletedPackage(dependentPackage: string, completedPackage: SfpPackage) {
        const pkgDescriptor = ProjectConfig.getPackageDescriptorFromConfig(dependentPackage, this.projectConfig);
        const packageBranch = this.projectConfig.packageDirectories.find(
            (dir) => dir.package === completedPackage.packageName
        ).branch;
        const dependency = pkgDescriptor.dependencies.find(
            (dependency) =>
                dependency.package === completedPackage.packageName ||
                dependency.package.includes(`${completedPackage.packageName}@`)
        );
        if (dependency.package.includes(`${completedPackage.packageName}@`)) {
            if (packageBranch) {
                const [packageName, version, branch] = this.extractPackageVersionAndBranch(dependency.package);
                SFPLogger.log(
                    `New branched package is created for dependency: ${packageName}, update the package version id`,
                    LoggerLevel.INFO
                );
                dependency.package = `${packageName}@${completedPackage.package_version_number}-${branch}`;
                this.projectConfig.packageAliases[dependency.package] = completedPackage.package_version_id;
            }
        } else {
            dependency.versionNumber = completedPackage.versionNumber;
        }
    }

    /*************************************************************************************************************************************************
        Get package type for all package build job
    *************************************************************************************************************************************************/

    private getPriorityandTypeOfAPackage(projectConfig: any, pkg: string) {
        let priority = 0;
        let childs = DependencyHelper.getChildsOfAllPackages(this.props.projectDirectory, this.packagesToBeBuilt);
        let type = ProjectConfig.getPackageType(projectConfig, pkg);
        if (type === PackageType.Unlocked) {
            if (childs[pkg].length > 0) priority = PRIORITY_UNLOCKED_PKG_WITH_DEPENDENCY;
            else priority = PRIORITY_UNLOCKED_PKG_WITHOUT_DEPENDENCY;
        } else if (type === PackageType.Source) {
            priority = PRIORITY_SOURCE_PKG;
        } else if (type === PackageType.Data) {
            priority = PRIORITY_DATA_PKG;
        } else if (type === PackageType.Diff) {
            priority = PRIORITY_SOURCE_PKG;
        } else {
            throw new Error(`Unknown package type ${type}`);
        }

        return { priority, type };
    }

    /*************************************************************************************************************************************************
        Print all package infos after successfully build job
    *************************************************************************************************************************************************/

    private async printPackageDetails(sfpPackage: SfpPackage) {
        BuildStreamService.buildPackageSuccessList(sfpPackage.packageName);
		BuildStreamService.sendPackageCompletedInfos(sfpPackage);
        SFPLogger.log(
            COLOR_HEADER(
                `${EOL}${sfpPackage.packageName} package created in ${getFormattedTime(
                    sfpPackage.creation_details.creation_time
                )}`
            )
        );

        SFPLogger.log(COLOR_HEADER(`-- Package Details:--`));
        const table = new Table({
            chars: COLON_MIDDLE_BORDER_TABLE,
            style: { 'padding-left': 2 },
        });
        table.push([COLOR_HEADER(`Package Type`), COLOR_KEY_MESSAGE(sfpPackage.package_type)]);
        table.push([COLOR_HEADER(`Package Version Number`), COLOR_KEY_MESSAGE(sfpPackage.package_version_number)]);

        if (sfpPackage.package_type !== PackageType.Data) {
            if (sfpPackage.package_type == PackageType.Unlocked) {
                if (sfpPackage.package_version_id)
                    table.push([COLOR_HEADER(`Package Version Id`), COLOR_KEY_MESSAGE(sfpPackage.package_version_id)]);
                if (sfpPackage.test_coverage)
                    table.push([COLOR_HEADER(`Package Test Coverage`), COLOR_KEY_MESSAGE(sfpPackage.test_coverage)]);
                if (sfpPackage.has_passed_coverage_check)
                    table.push([
                        COLOR_HEADER(`Package Coverage Check Passed`),
                        COLOR_KEY_MESSAGE(sfpPackage.has_passed_coverage_check),
                    ]);
            }

            table.push([COLOR_HEADER(`Metadata Count`), COLOR_KEY_MESSAGE(sfpPackage.metadataCount)]);
            table.push([COLOR_HEADER(`Apex In Package`), COLOR_KEY_MESSAGE(sfpPackage.isApexFound ? 'Yes' : 'No')]);
            table.push([
                COLOR_HEADER(`Profiles In Package`),
                COLOR_KEY_MESSAGE(sfpPackage.isProfilesFound ? 'Yes' : 'No'),
            ]);

            if (sfpPackage.packageType == PackageType.Diff) {
                table.push([COLOR_HEADER(`Source Version From`), COLOR_KEY_MESSAGE(sfpPackage.commitSHAFrom)]);
                table.push([COLOR_HEADER(`Source Version To`), COLOR_KEY_MESSAGE(sfpPackage.commitSHATo)]);

                table.push([
                    COLOR_HEADER(`Invalidated Test Classes`),
                    COLOR_KEY_MESSAGE(sfpPackage.apexTestClassses?.length),
                ]);
            }
            table.push([COLOR_HEADER(`Source Version`), COLOR_KEY_MESSAGE(sfpPackage.sourceVersion)]);

            SFPLogger.log(table.toString());

            const packageDependencies = this.projectConfig.packageDirectories.find(
                (dir) => dir.package === sfpPackage.package_name
            ).dependencies;
            if (packageDependencies && Array.isArray(packageDependencies) && packageDependencies.length > 0) {
                SFPLogger.log(COLOR_HEADER(`  Resolved package dependencies:`));
                PackageDependencyDisplayer.printPackageDependencies(
                    packageDependencies,
                    this.projectConfig,
                    new ConsoleLogger()
                );
            }
        }
    }

    /*************************************************************************************************************************************************
        Package version create request 
    *************************************************************************************************************************************************/

    private async createPackage(
        packageType: string,
        sfdx_package: string,
        isValidateMode: boolean
    ): Promise<SfpPackage> {
        if (!this.props.isDiffCheckEnabled) {
            SFPLogger.log(COLOR_KEY_MESSAGE(`Package creation initiated for ${sfdx_package}`));
        }
        let configFilePath = this.props.configFilePath;
        if (this.isMultiConfigFilesEnabled) {
            if (this.scratchOrgDefinitions[sfdx_package]) {
                configFilePath = this.scratchOrgDefinitions[sfdx_package];
                SFPLogger.log(
                    COLOR_KEY_MESSAGE(
                        `Matched scratch org definition file found for ${sfdx_package}: ${configFilePath}`
                    )
                );
            }
        }

        //Compute revision from and revision to
        let revisionFrom: string;
        let revisionTo: string;

        //let package itself create revisions
        if (packageType == PackageType.Diff) {
            revisionFrom = undefined;
            revisionTo = undefined;
        } else {
            revisionFrom = this.props.diffOptions?.packagesMappedToLastKnownCommitId?.[sfdx_package]
                ? this.props.diffOptions?.packagesMappedToLastKnownCommitId[sfdx_package]
                : undefined;
            revisionTo = this.props.diffOptions?.packagesMappedToLastKnownCommitId?.[sfdx_package] ? 'HEAD' : undefined;
        }

        return SfpPackageBuilder.buildPackageFromProjectDirectory(
            new FileLogger(`.sfpowerscripts/logs/${sfdx_package}`),
            this.props.projectDirectory,
            sfdx_package,
            {
                overridePackageTypeWith: this.props.overridePackageTypes
                    ? this.props.overridePackageTypes[sfdx_package]
                    : undefined,
                branch: this.props.branch,
                sourceVersion: this.commit_id,
                repositoryUrl: this.repository_url,
                configFilePath: configFilePath,
                pathToReplacementForceIgnore: this.getPathToForceIgnoreForCurrentStage(
                    this.projectConfig,
                    this.props.currentStage
                ),
                revisionFrom: revisionFrom,
                revisionTo: revisionTo,
            },
            {
                devHub: this.props.devhubAlias,
                installationkeybypass: true,
                installationkey: undefined,
                waitTime: this.props.waitTime.toString(),
                isCoverageEnabled: !this.props.isQuickBuild,
                isSkipValidation: this.props.isQuickBuild,
                breakBuildIfEmpty: true,
                baseBranch: this.props.baseBranch,
                buildNumber: this.props.buildNumber.toString(),
            },
            this.projectConfig
        );
    }

    /*************************************************************************************************************************************************
        Get the file path of the forceignore for current stage, from project config.
        Returns null if a forceignore path is not defined in the project config for the current stage.
    *************************************************************************************************************************************************/

    private getPathToForceIgnoreForCurrentStage(projectConfig: any, currentStage: Stage): string {
        let stageForceIgnorePath: string;

        let ignoreFiles: { [key in Stage]: string } = projectConfig.plugins?.sfpowerscripts?.ignoreFiles;
        if (ignoreFiles) {
            Object.keys(ignoreFiles).forEach((key) => {
                if (key.toLowerCase() == currentStage) {
                    stageForceIgnorePath = ignoreFiles[key];
                }
            });
        }

        if (stageForceIgnorePath) {
            if (fs.existsSync(stageForceIgnorePath)) {
                return stageForceIgnorePath;
            } else throw new Error(`${stageForceIgnorePath} forceignore file does not exist`);
        } else return null;
    }

    /*************************************************************************************************************************************************
        Get the files for multi scratch orgs
    *************************************************************************************************************************************************/

    private getMultiScratchOrgDefinitionFileMap(projectConfig: any): { [key: string]: any }[] {
        this.isMultiConfigFilesEnabled =
            this.projectConfig?.plugins?.sfpowerscripts?.scratchOrgDefFilePaths?.enableMultiDefinitionFiles;
        let configFiles: { [key: string]: any }[];
        if (this.isMultiConfigFilesEnabled) {
            configFiles = this.projectConfig?.plugins?.sfpowerscripts?.scratchOrgDefFilePaths?.packages;
        }
        return configFiles;
    }

    /*************************************************************************************************************************************************
        Resolve package deps from project config
    *************************************************************************************************************************************************/

    private async resolvePackageDependencies(projectConfig: any) {
        let isDependencyResolverEnabled = !projectConfig?.plugins?.sfpowerscripts?.disableTransitiveDependencyResolver;

        if (isDependencyResolverEnabled) {
            const transitiveDependencyResolver = new TransitiveDependencyResolver(projectConfig, this.logger);
            let resolvedDependencyMap = await transitiveDependencyResolver.resolveTransitiveDependencies();
            projectConfig = await ProjectConfig.updateProjectConfigWithDependencies(
                projectConfig,
                resolvedDependencyMap
            );
            projectConfig = await new UserDefinedExternalDependency().cleanupEntries(projectConfig);
            return projectConfig;
        } else {
            return projectConfig;
        }
    }

    /*************************************************************************************************************************************************
        Get the package version from alias and branch
    *************************************************************************************************************************************************/

    private extractPackageVersionAndBranch(packageAlias: string): [string, string, string] {
        const parts = packageAlias.split('@');

        if (parts.length === 2) {
            const packageName = parts[0];
            const versionAndFeature = parts[1].split('-');

            if (versionAndFeature.length === 2) {
                const version = versionAndFeature[0];
                const branch = versionAndFeature[1];

                return [packageName, version, branch];
            }
        }

        return ['', '', ''];
    }

    /*************************************************************************************************************************************************
        makes the request to get the code coverage for a subriber package version This method is depraceted and can be removed when the issue from @salesforce/packaging is fixed
    *************************************************************************************************************************************************/

    private async getPackageInfo(sfpPackage: SfpPackage, connection: Connection<Schema>) {
        let packageVersionCoverage: PackageVersionCoverage = new PackageVersionCoverage(connection, this.logger);
        let count = 0;
        while (count < 10) {
            count++;
            try {
                SFPLogger.log(COLOR_TRACE('Fetching Version Number and Coverage details'), LoggerLevel.TRACE);

                let pkgInfoResult = await packageVersionCoverage.getCoverage(sfpPackage.package_version_id);

                sfpPackage.isDependencyValidated = !this.props.isQuickBuild;
                sfpPackage.package_version_number = pkgInfoResult.packageVersionNumber;
                sfpPackage.test_coverage = pkgInfoResult.coverage;
                sfpPackage.has_passed_coverage_check = pkgInfoResult.HasPassedCodeCoverageCheck;
                break;
            } catch (error) {
                SFPLogger.log(
                    `Unable to fetch package version info due to ${error.message}`,
                    LoggerLevel.INFO,
                    this.logger
                );
                SFPLogger.log('Retrying...', LoggerLevel.INFO, this.logger);
                await delay(2000);
                continue;
            }
        }
    }
}
