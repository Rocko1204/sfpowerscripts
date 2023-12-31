import axios from 'axios';
import SFPLogger, { LoggerLevel, COLOR_TRACE, COLOR_WARNING } from '@dxatscale/sfp-logger';
import SFPOrg from '../org/SFPOrg';
import { SfPowerscriptsEvent__c } from './types';
import pQueue from 'p-queue';
import 'dotenv/config';

export class HookService<T> {
    private static instance: HookService<any>;
    private q: pQueue;

    public static getInstance(): HookService<any> {
        if (!HookService.instance) {
            HookService.instance = new HookService();
            this.instance.q = new pQueue({ concurrency: 1 });
        }
        return HookService.instance;
    }

    public async logEvent(event: T) {
        //###send webkooks### only when the env variables are set
        if (process.env.EVENT_STREAM_WEBHOOK_URL) {
            const axiosInstance = axios.create();
            axiosInstance.defaults.headers.common['Authorization'] = process.env.EVENT_STREAM_WEBHOOK_TOKEN;
            axiosInstance.defaults.baseURL = process.env.EVENT_STREAM_WEBHOOK_URL;
            // datetime not enough , so we need math.random to make it unique
            const payload = {
                eventType: event['context']['eventType'],
                eventId: `${event['context']['eventId']}_${Math.floor(10000 + Math.random() * 90000)}`,
                payload: event,
            };

            this.q.add(() =>
                axiosInstance
                    .post(``, JSON.stringify(payload))
                    .then(async (commitResponse) => {
                        if (commitResponse.status === 201) {
                            SFPLogger.log(COLOR_TRACE(`Commit successful.`), LoggerLevel.TRACE);
                        } else {
                            SFPLogger.log(
                                COLOR_TRACE(`Commit failed. Status code: ${commitResponse.status}`),
                                LoggerLevel.TRACE
                            );
                        }
                    })
                    .catch((error) => {
                        SFPLogger.log(
                            COLOR_TRACE(`An error happens for the webkook callout: ${error}`),
                            LoggerLevel.INFO
                        );
                    })
            );
        }

        if (!event['context']['devHubAlias'] && event['context']['jobId'].includes('NO_DEV_HUB_IMPL')) {
            return;
        }

        const sfpOrg = await SFPOrg.create({
            aliasOrUsername: event['context']['devHubAlias'],
        });

        const connection = sfpOrg.getConnection();

        const sfpEvent: SfPowerscriptsEvent__c[] = [
            {
                Name: `${event['context']['jobId']}-${event['metadata']['package']}`,
                Command__c: event['context']['command'],
                JobId__c: event['context']['jobId'],
                Branch__c: event['context']['branch'],
                Commit__c: event['context']['commitId'],
                EventId__c: event['context']['eventId'],
                InstanceUrl__c: event['context']['instanceUrl'],
                JobTimestamp__c: event['context']['timestamp'],
                EventName__c: event['event'],
                Package__c: event['metadata']['package'],
                ErrorMessage__c:
                    event['metadata']['message'] ? event['metadata']['message'] : '',
            },
        ];

        this.q.add(() =>
            connection
                .sobject('SfPowerscriptsEvent__c')
                .upsert(sfpEvent, 'Name')
                .then(async (upsertResult) => {
                    SFPLogger.log(COLOR_TRACE('Upsert successful:', upsertResult), LoggerLevel.TRACE);
                })
                .catch((error) => {
                    SFPLogger.log(COLOR_TRACE('Error:', error), LoggerLevel.TRACE);
                    SFPLogger.log(
                        COLOR_WARNING(
                            'We cannot send the events to your DevHub. Please check that the package id 04t2o000001B1jzAAC is installed on DevHub and the username has the permissions.'
                        ),
                        LoggerLevel.TRACE
                    );
                })
        );
    }
}
