// Local code capability contract. This does not inspect an account or assert production enablement.
import { DEFAULT_ANALYSIS_TYPES, HEALTH_SYNC_ORIGIN, TYPES } from './protocol.mts';

export const WEB_READ_TYPES = ['ExerciseSessionRecord', 'SleepSessionRecord'] as const;
export const WEB_DEFAULT_TYPES = ['ExerciseSessionRecord'] as const;
export const WEB_IMPORT_ROUTES = {
  activity: '/api/health/trainingcamp/import', sleep: '/api/health/trainingcamp/sleep/import',
} as const;

export function bridgeFrameworkOverview() {
  return {
    project: 'Health AI Bridge', scope: 'local_code_capabilities_not_live_account_or_deployment_status',
    localEntryPoints: { cli: 'backend/bridge-command.mts', windowsDesktop: 'tools/Bridge.ps1 -Action desktop' },
    layers: ['source_collection', 'local_import_tasks', 'original_authenticated_REST', 'source_isolated_storage',
      'original_read_only_MCP', 'mobile_ChatGPT'],
    sources: {
      health_sync: { queryTypes: [...TYPES], defaultQueryTypes: [...DEFAULT_ANALYSIS_TYPES],
        requiredOrigin: HEALTH_SYNC_ORIGIN, collector: 'existing_Android_Health_Connect',
        backgroundScheduling: 'existing_Android_WorkManager_requires_separate_real_device_acceptance' },
      huawei_trainingcamp: { queryTypes: [...WEB_READ_TYPES], defaultQueryTypes: [...WEB_DEFAULT_TYPES],
        importRoutes: WEB_IMPORT_ROUTES, enablement: 'explicit_feature_flag_and_database_migrations_required',
        collection: { sleep: 'manual_browser_capture',
          activity: 'manual_browser_first_response_max_20_bounded_scroll_max_100_or_provided_record_array',
          sourcePagination: 'activity_bounded_scroll_completeness_unknown' },
        localTasks: ['preview_offline_without_task', 'prepare_offline', 'list_task_ids_offline', 'confirm_upload', 'save_receipt', 'inspect_offline', 'choose_query_arguments', 'export_chatgpt_guide_offline'],
        sleepRead: 'explicit_immutable_snapshot', activityRead: 'live_records_in_explicit_window',
        dailyStepsAndFullDayHeartRate: 'not_implemented_or_verified',
        automaticCollectionAndUpload: 'not_implemented',
      },
    },
    invariants: ['default_Health_Sync_only', 'no_cross_source_merge_or_fallback', 'explicit_dates_and_identity',
      'no_network_before_upload_confirmation', 'same_task_same_batch_on_retry', 'no_automatic_MCP_call'],
  };
}
