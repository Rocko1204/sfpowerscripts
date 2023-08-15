import axios, { AxiosInstance } from 'axios';
import SFPLogger, { LoggerLevel, COLOR_TRACE } from '@dxatscale/sfp-logger';

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
                SFPLogger.log(COLOR_TRACE(`Commit successful.`), LoggerLevel.INFO);
            } else {
                SFPLogger.log(COLOR_TRACE(`Commit failed. Status code: ${commitResponse.status}`), LoggerLevel.TRACE);
            }
        } catch (error) {
            SFPLogger.log(COLOR_TRACE(`An error happens: ${error}`), LoggerLevel.INFO);
        } 
    }
}
