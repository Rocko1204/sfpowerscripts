import SFPLogger, { Logger, LoggerLevel } from '@dxatscale/sfp-logger';
import { ComponentSet, registry } from '@salesforce/source-deploy-retrieve';
import SfpPackage, { PackageType } from '../SfpPackage';
import { Connection } from '@salesforce/core';
import { PreDeployer } from './PreDeployer';
import { Schema } from 'jsforce';
import QueryHelper from '../../queryHelper/QueryHelper';
import lodash from 'lodash';

const QUERY_BODY =
    'SELECT Id FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = ';


export default class PicklistEnabler implements PreDeployer {
    public async isEnabled(sfpPackage: SfpPackage, conn: Connection<Schema>, logger: Logger): Promise<boolean> {

        if (sfpPackage.packageType === PackageType.Unlocked) {
            if (
                sfpPackage.isPickListsFound 
            ) {
                return true;
            }
        }
        else
          return false;
    }

    public async execute(
        componentSet: ComponentSet,
        conn: Connection,
        logger: Logger
    ) {

        try {
            let sourceComponents = componentSet.getSourceComponents().toArray();
            let components = [];

            for (const sourceComponent of sourceComponents) {
                if (sourceComponent.type.name == registry.types.customobject.name) {
                    components.push(...sourceComponent.getChildren());
                }

                if (sourceComponent.type.name == registry.types.customobject.children.types.customfield.name) {
                    components.push(sourceComponent);
                }
            }

            if (components) {
                for (const fieldComponent of components) {
                    let customField = fieldComponent.parseXmlSync().CustomField;

                    if (!customField || customField['type'] !== 'Picklist' ||  !customField.valueSet?.valueSetDefinition) {
                        continue;
                    }

                    if(customField['fieldManageability']){
                        continue;
                    }

                    let objName = fieldComponent.parent.fullName;
                    let picklistName = fieldComponent.name;
                    let urlId = QUERY_BODY + '\'' + objName + '\'' + ' AND QualifiedApiName = ' + '\'' + picklistName + '\'';

                    let picklistValueSource = await this.getPicklistSource(customField);

                    let picklistInOrg = await this.getPicklistInOrg(urlId, conn);
                    if(!picklistInOrg && !picklistInOrg?.Metadata?.valueSet?.valueSetDefinition) continue;
                    let picklistValueInOrg = [];

                    for (const value of picklistInOrg.Metadata.valueSet.valueSetDefinition.value) {

                        if (value.isActive == 'false') {
                            continue;
                        }

                        let valueInfo: { [key: string]: string } = {};
                        valueInfo.fullName = value['valueName'];
                        valueInfo.default = value['default'] && value['default'] === true ? 'true' : 'false';
                        valueInfo.label = value['label'];
                        picklistValueInOrg.push(valueInfo);
                    }

                    let isPickListIdentical =  this.arePicklistsIdentical(picklistValueInOrg, picklistValueSource);

                    if (!isPickListIdentical) {
                        this.deployPicklist(picklistInOrg, picklistValueSource, conn);
                    } else {
                        SFPLogger.log(`Picklist for custom field ${picklistInOrg.FullName} identical. No deployment`, LoggerLevel.INFO, null);
                    }
                }
            }
        } catch (error) {
            SFPLogger.log(`Unable to process Picklist update due to ${error.message}`, LoggerLevel.WARN, logger);
        }
    }


    private async getPicklistInOrg(urlId: string, conn: Connection): Promise<any> {

        let response = await QueryHelper.query<any>(urlId, conn, true);

        if (response && Array.isArray(response) && response.length > 0 && response[0].attributes) {
            let responseUrl = response[0].attributes.url;
            let fieldId = responseUrl.slice(responseUrl.lastIndexOf('.') + 1);
            let responsePicklist = await conn.tooling.sobject('CustomField').find({ Id: fieldId });

            if (responsePicklist) {
                return responsePicklist[0];
            }
        }
    }

    private async getPicklistSource(customField: any): Promise<any[]> {
        let picklistValueSet = [];
        let values = customField.valueSet?.valueSetDefinition?.value;

        if (Array.isArray(values)) {
            picklistValueSet.push(...values);
        } else if(typeof values === 'object' && 'fullName' in values) {
            picklistValueSet.push(values);
        }
        return picklistValueSet;
    }

    private arePicklistsIdentical(picklistValueInOrg: any[], picklistValueSource: any[]): boolean {
        return (
            picklistValueInOrg.length === picklistValueSource.length &&
            picklistValueInOrg.every((element_1) =>
                picklistValueSource.some(
                    (element_2) =>
                        element_1.fullName === element_2.fullName &&
                        element_1.label === element_2.label &&
                        element_1.default === element_2.default
                )
            )
        );
    }

    private async deployPicklist(picklistInOrg: any, picklistValueSource: any, conn: Connection) {
        //empty the the old value set
        picklistInOrg.Metadata.valueSet.valueSetDefinition.value = [];
        picklistValueSource.map(value => {
            picklistInOrg.Metadata.valueSet.valueSetDefinition.value.push(value);
        });
        picklistInOrg.Metadata.valueSet.valueSettings = [];


        let picklistToDeploy : any;
        picklistToDeploy = {attributes: picklistInOrg.attributes,
                            Id: picklistInOrg.Id,
                                Metadata: picklistInOrg.Metadata,
                                FullName: picklistInOrg.FullName};

        SFPLogger.log(`Update picklist for custom field ${picklistToDeploy.FullName}`, LoggerLevel.INFO, null);
        try {
            await conn.tooling.sobject('CustomField').update(picklistToDeploy);
        } catch (error) {
            throw new Error(
                `Unable to update picklist for custom field ${picklistToDeploy.FullName} due to ${error.message}`
            );
        }
    }

    public getName(): string {
        return 'Picklist Enabler';
    }
}
