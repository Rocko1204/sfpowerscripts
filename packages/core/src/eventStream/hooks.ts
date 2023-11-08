import axios, { AxiosInstance } from 'axios';
import SFPLogger, { LoggerLevel, COLOR_TRACE, ConsoleLogger } from '@dxatscale/sfp-logger';
import SFPOrg from '../org/SFPOrg';
import { GitEvent__c } from './types';


export class HookService<T> {
    private static instance: HookService<any>;
    private axiosInstance: AxiosInstance;

    private constructor() {
        this.axiosInstance = axios.create();
        if (process.env.EVENT_STREAM_WEBHOOK_TOKEN) {
            this.axiosInstance.defaults.headers.common['Authorization'] = process.env.EVENT_STREAM_WEBHOOK_TOKEN;
            this.axiosInstance.defaults.baseURL = process.env.EVENT_STREAM_WEBHOOK_URL;
        }
    }

    public static getInstance(): HookService<any> {
        if (!HookService.instance) {
            HookService.instance = new HookService();
        }
        return HookService.instance;
    }

    public async logEvent(event: T) {
        const payload = {source: "sfpowerscripts",sourcetype: "gitlab",event: event};
        // Create a new commit
       
        try {
            const commitResponse = await this.axiosInstance.post(``, JSON.stringify(payload));

            if (commitResponse.status === 201) {
                SFPLogger.log(COLOR_TRACE(`Commit successful.`), LoggerLevel.TRACE);
            } else {
                SFPLogger.log(COLOR_TRACE(`Commit failed. Status code: ${commitResponse.status}`), LoggerLevel.TRACE);
            }
        } catch (error) {
            SFPLogger.log(COLOR_TRACE(`An error happens: ${error}`), LoggerLevel.INFO);
        } 

        const sfpOrg = await SFPOrg.create({
            aliasOrUsername: process.env.DEVHUB_ALIAS,
        });

        const connection = sfpOrg.getConnection()
        
        const gitEvent:GitEvent__c[] = [{
            Name: `${event['context']['jobId']}-${event['metadata']['package']}`, 
            Command__c: event['context']['command'],
            EventId__c: event['context']['eventId'],
            InstanceUrl__c: event['context']['instanceUrl'],
            JobTimestamp__c: event['context']['timestamp'],
            EventName__c: event['event'],
            Package__c: event['metadata']['package'],
            Message__c: event['metadata']['message'].length > 0  ? JSON.stringify(event['metadata']['message']) : '',
            DeployError__c: event['metadata']['deployErrors'] ? JSON.stringify(event['metadata']['deployErrors']) : ''
        }]

        const upsertGitEvents = async () => {
            try {
                const result = await connection.sobject('GitEvent__c').upsert(gitEvent, 'Name');
                onResolved(result);
            } catch (error) {
                onReject(error);
            }
        };
        
        const onResolved = (res) => {
            SFPLogger.log(COLOR_TRACE('Upsert successful:', res), LoggerLevel.TRACE);
            // Implement your custom logic here for resolved cases
        };
        
        const onReject = (err) => {
            console.error('Error:', err);
            SFPLogger.log(COLOR_TRACE('Error:', err), LoggerLevel.TRACE);
            // Implement your custom error handling logic here for rejected cases
        };
        
        await upsertGitEvents()
            .then(() => SFPLogger.log(COLOR_TRACE('Promise resolved successfully.'), LoggerLevel.TRACE))
            .catch((err) => SFPLogger.log(COLOR_TRACE('Promise rejected:', err), LoggerLevel.TRACE))   
        
    }
}
