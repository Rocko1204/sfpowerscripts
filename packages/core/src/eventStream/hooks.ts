import axios, { AxiosInstance } from 'axios';
import { Subject } from 'rxjs';
import SFPLogger, { LoggerLevel, COLOR_TRACE } from '@dxatscale/sfp-logger';


export class HookService<T> {
    private static instance: HookService<any>;
    private axiosInstance: AxiosInstance;
    private logSubject: Subject<T>;

    private isLogEventRunning: boolean = false;

    private constructor() {
        this.axiosInstance = axios.create();
        if (process.env.GITLAB_TOKEN) {
            this.axiosInstance.defaults.headers.common['Authorization'] = process.env.GITLAB_TOKEN;
            this.axiosInstance.defaults.baseURL = 'https://git.eon-cds.de/api/v4/projects';
        }
    }

    public static getInstance(): HookService<any> {
        if (!HookService.instance) {
            HookService.instance = new HookService();
        }
        return HookService.instance;
    }

    public async logEvent(event: T) {
        const file_path = 'eventStreams%2Fsfpowerscripts%2Ejson?ref=main';
        const file_path_encoded = 'eventStreams/sfpowerscripts.json';
        const project_id = '10309';

        if (this.isLogEventRunning) {
            console.log('Another logEvent call is already in progress. Skipping...');
            await new Promise((resolve) => setTimeout(resolve, 3000));
        }

        this.isLogEventRunning = true;

        const response = await this.axiosInstance.get(`/${project_id}/repository/files/${file_path}`);

        const existingContent = Buffer.from(response.data.content, 'base64').toString('utf-8');

        // Update the JSON data
        const existingJson = JSON.parse(existingContent);
        existingJson.events.push(event);
        const updatedContent = JSON.stringify(existingJson, null, 2);

        // Create a new commit
        const commitMessage = '[skip-ci] update event file from automated sfpowerscripts job';
        const commitPayload = {
            branch: 'main',
            commit_message: commitMessage,
            actions: [
                {
                    action: 'update',
                    file_path: file_path_encoded,
                    content: updatedContent,
                },
            ],
        };
        try {
            const commitResponse = await this.axiosInstance.post(`/${project_id}/repository/commits`, commitPayload);

            if (commitResponse.status === 201) {
                SFPLogger.log(COLOR_TRACE(`Commit successful.`), LoggerLevel.TRACE);
            } else {
                //SFPLogger.log(COLOR_TRACE(`Commit failed. Status code: ${commitResponse.status}`), LoggerLevel.TRACE);
            }
        } catch (error) {
            SFPLogger.log(COLOR_TRACE(`An error happens: ${error}`), LoggerLevel.TRACE);
        } finally {
            this.isLogEventRunning = false;
        }
    }
}
