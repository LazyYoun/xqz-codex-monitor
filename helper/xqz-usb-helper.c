#include <libusb.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;

static void stop_running(int signal_number) {
    (void)signal_number;
    running = 0;
}

int main(void) {
    signal(SIGINT, stop_running);
    signal(SIGTERM, stop_running);

    libusb_context *context = NULL;
    libusb_device_handle *device = NULL;
    if (libusb_init(&context) != 0) return 10;
    device = libusb_open_device_with_vid_pid(context, 0x054c, 0x0e48);
    if (!device) {
        puts("waiting:no-device");
        fflush(stdout);
        libusb_exit(context);
        return 2;
    }
    if (libusb_claim_interface(device, 0) != 0) {
        puts("error:claim-failed");
        fflush(stdout);
        libusb_close(device);
        libusb_exit(context);
        return 3;
    }

    puts("ready");
    fflush(stdout);
    unsigned char response[64];
    while (running) {
        int transferred = 0;
        unsigned char show[] = "show";
        int result = libusb_bulk_transfer(device, 0x02, show, 4, &transferred, 80);
        if (result != 0 || transferred != 4) {
            puts("error:show-failed");
            fflush(stdout);
            break;
        }

        transferred = 0;
        result = libusb_bulk_transfer(device, 0x81, response, sizeof(response) - 1, &transferred, 60);
        if (result == 0 && transferred > 0) {
            response[transferred] = 0;
            printf("event:%s\n", response);
            fflush(stdout);
        } else if (result != LIBUSB_ERROR_TIMEOUT && result != 0) {
            puts("error:read-failed");
            fflush(stdout);
            break;
        }
        usleep(320000);
    }

    int transferred = 0;
    unsigned char stop[] = "stop";
    libusb_bulk_transfer(device, 0x02, stop, 4, &transferred, 100);
    libusb_release_interface(device, 0);
    libusb_close(device);
    libusb_exit(context);
    return 0;
}
