#import "AppDelegate.h"
#import <GoogleMobileAds/GoogleMobileAds.h>
@import FirebaseCore;

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    return YES;
}

- (void)createAccount:(NSString *)email {
    // Fixture placeholder: real account creation logic lives elsewhere.
    NSLog(@"Creating account for %@", email);
}

@end
