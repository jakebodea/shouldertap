#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

// Exposes the Swift `ShouldertapNative` module to the React Native bridge.
@interface RCT_EXTERN_MODULE (ShouldertapNative, RCTEventEmitter)

RCT_EXTERN_METHOD(showOverlay : (NSDictionary *)payload)
RCT_EXTERN_METHOD(hideOverlay)
RCT_EXTERN_METHOD(debugSnapshot : (NSString *)directory resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(openPopover)
RCT_EXTERN_METHOD(closePopover)
RCT_EXTERN_METHOD(setPending : (BOOL)pending)
RCT_EXTERN_METHOD(quit)
RCT_EXTERN_METHOD(deviceName : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(copyToClipboard : (NSString *)text)
RCT_EXTERN_METHOD(qrCode : (NSString *)text resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(launchAtLogin : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setLaunchAtLogin : (BOOL)enabled resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getSecret : (NSString *)key resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setSecret : (NSString *)key value : (NSString *)value resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(deleteSecret : (NSString *)key resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(getItem : (NSString *)key resolver : (RCTPromiseResolveBlock)resolve rejecter : (RCTPromiseRejectBlock)reject)
RCT_EXTERN_METHOD(setItem : (NSString *)key value : (NSString *)value)

@end
