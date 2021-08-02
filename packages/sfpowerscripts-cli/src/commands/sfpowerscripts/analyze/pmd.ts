import { flags } from "@salesforce/command";
import SfpowerscriptsCommand from "../../../SfpowerscriptsCommand";
import { Messages } from "@salesforce/core";
import AnalyzeWithPMDImpl from "@dxatscale/sfpowerscripts.core/lib/sfpowerkitwrappers/AnalyzeWithPMDImpl";
import xml2js = require("xml2js");
import SFPLogger, { ConsoleLogger } from "@dxatscale/sfpowerscripts.core/lib/logger/SFPLogger";
const fs = require("fs");

// Initialize Messages with the current plugin directory
Messages.importMessagesDirectory(__dirname);

// Load the specific messages for this file. Messages from @salesforce/command, @salesforce/core,
// or any library that is using the messages framework can also be loaded this way.
const messages = Messages.loadMessages(
  "@dxatscale/sfpowerscripts",
  "analyze_with_PMD"
);

export default class AnalyzeWithPMD extends SfpowerscriptsCommand {
  public static description = messages.getMessage("commandDescription");

  public static examples = [
    `$ sfdx sfpowerscripts:analyze:pmd -b\n`,
    `Output variable:`,
    `sfpowerscripts_pmd_output_path`,
    `<refname>_sfpowerscripts_pmd_output_path`,
  ];

  protected static requiresProject = true;
  protected static requiresUsername = false;
  protected static requiresDevhubUsername = false;

  protected static flagsConfig = {
    sourcedir: flags.string({
      description: messages.getMessage("sourceDirectoryFlagDescription"),
    }),
    ruleset: flags.string({
      description: messages.getMessage("rulesetFlagDescription"),
      options: ["sfpowerkit", "Custom"],
      default: "sfpowerkit",
    }),
    rulesetpath: flags.string({
      description: messages.getMessage("rulesetPathFlagDescription"),
    }),
    format: flags.string({
      description: messages.getMessage("formatFlagDescription"),
      options: [
        "text",
        "textcolor",
        "csv",
        "emacs",
        "summaryhtml",
        "html",
        "xml",
        "xslt",
        "yahtml",
        "vbhtml",
        "textpad",
        "sarif",
      ],
      default: "text",
    }),
    outputpath: flags.string({
      char: "o",
      description: messages.getMessage("outputPathFlagDescription"),
    }),
    version: flags.string({
      required: false,
      default: "6.34.0",
      description: messages.getMessage("versionFlagDescription"),
    }),
    istobreakbuild: flags.boolean({
      char: "b",
      deprecated: {
        messageOverride:
          "--istobreakbuild has been deprecated, the command will always break",
      },
      description: messages.getMessage("isToBreakBuildFlagDescription"),
    }),
    refname: flags.string({
      description: messages.getMessage("refNameFlagDescription"),
    }),
    loglevel: flags.enum({
      description: "logging level for this command invocation",
      default: "info",
      required: false,
      options: [
        "trace",
        "debug",
        "info",
        "warn",
        "error",
        "fatal",
        "TRACE",
        "DEBUG",
        "INFO",
        "WARN",
        "ERROR",
        "FATAL",
      ],
    }),
  };

  public async execute() {
    try {
      const source_directory: string = this.flags.sourcedir;
      const ruleset: string = this.flags.ruleset;

      let rulesetpath = "";
      if (ruleset == "Custom") {
        console.log("Custom Rulesets are temporaily disabled, Please check back in few days");
      }

      const format: string = this.flags.format;
      const outputPath: string = this.flags.outputpath;
      const version: string = this.flags.version;

      let pmdImpl: AnalyzeWithPMDImpl = new AnalyzeWithPMDImpl(
        source_directory,
        rulesetpath,
        format,
        outputPath,
        version,
        new ConsoleLogger(),
        SFPLogger.logLevel
      );

      await pmdImpl.exec(false);

     

    } catch (err) {
      console.log(err);
      // Fail the task when an error occurs
      process.exit(1);
    }
  }

  private parseXmlReport(xmlReport: string): [number, number, number] {
    let fileCount = 0;
    let violationCount = 0;
    let criticaldefects = 0;

    let reportContent: string = fs.readFileSync(xmlReport, "utf-8");
    xml2js.parseString(reportContent, (err, data) => {
      // If the file is not XML, or is not from PMD, return immediately
      if (!data || !data.pmd) {
        console.debug(`Empty or unrecognized PMD xml report ${xmlReport}`);
        return null;
      }

      if (!data.pmd.file || data.pmd.file.length === 0) {
        // No files with violations, return now that it has been marked for upload
        return null;
      }

      data.pmd.file.forEach((file: any) => {
        if (file.violation) {
          fileCount++;
          violationCount += file.violation.length;
        }
      });

      for (let i = 0; i < data.pmd.file.length; i++) {
        data.pmd.file[i].violation.forEach((element) => {
          if (element["$"]["priority"] == 1) {
            criticaldefects++;
          }
        });
      }
    });

    return [violationCount, fileCount, criticaldefects];
  }

}
