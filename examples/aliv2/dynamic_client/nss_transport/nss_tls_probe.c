#include <arpa/inet.h>
#include <netdb.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/tcp.h>
#include <unistd.h>

#include "nss.h"
#include "private/pprio.h"
#include "prio.h"
#include "prinit.h"
#include "secerr.h"
#include "ssl.h"
#include "sslerr.h"
#include "sslexp.h"
#include "sslproto.h"

static SECStatus accept_certificate(void *arg, PRFileDesc *fd, PRBool checksig,
                                    PRBool is_server) {
  (void)arg;
  (void)fd;
  (void)checksig;
  (void)is_server;
  const char *delay_text = getenv("NSS_CERT_DELAY_MS");
  if (delay_text) {
    long delay_ms = strtol(delay_text, NULL, 10);
    if (delay_ms > 0 && delay_ms <= 1000) usleep((useconds_t)delay_ms * 1000);
  }
  return SECSuccess;
}

static void fail(const char *what) {
  fprintf(stderr, "%s failed: PR_GetError=%d OS=%d\n", what, PR_GetError(),
          PR_GetOSError());
  exit(2);
}

static SECStatus unsupported_cert_decode(const SECItem *input,
                                         unsigned char *output,
                                         size_t output_len,
                                         size_t *used_len) {
  (void)input;
  (void)output;
  (void)output_len;
  *used_len = 0;
  PORT_SetError(SEC_ERROR_UNSUPPORTED_KEYALG);
  return SECFailure;
}

static void configure_firefox_tls(PRFileDesc *fd) {
  static const PRUint16 ciphers[] = {
      TLS_AES_128_GCM_SHA256,
      TLS_CHACHA20_POLY1305_SHA256,
      TLS_AES_256_GCM_SHA384,
      TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
      TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
      TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256,
      TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
      TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
      TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384,
      TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA,
      TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA,
      TLS_RSA_WITH_AES_128_GCM_SHA256,
      TLS_RSA_WITH_AES_256_GCM_SHA384,
      TLS_RSA_WITH_AES_128_CBC_SHA,
      TLS_RSA_WITH_AES_256_CBC_SHA,
  };
  static const SSLNamedGroup groups[] = {
      ssl_grp_kem_mlkem768x25519, ssl_grp_ec_curve25519,
      ssl_grp_ec_secp256r1,       ssl_grp_ec_secp384r1,
      ssl_grp_ec_secp521r1,       ssl_grp_ffdhe_2048,
      ssl_grp_ffdhe_3072,
  };
  static const SSLSignatureScheme signatures[] = {
      ssl_sig_ecdsa_secp256r1_sha256, ssl_sig_ecdsa_secp384r1_sha384,
      ssl_sig_ecdsa_secp521r1_sha512, ssl_sig_rsa_pss_sha256,
      ssl_sig_rsa_pss_sha384,         ssl_sig_rsa_pss_sha512,
      ssl_sig_rsa_pkcs1_sha256,       ssl_sig_rsa_pkcs1_sha384,
      ssl_sig_rsa_pkcs1_sha512,       ssl_sig_rsa_pkcs1_sha1,
  };
  const PRUint16 *implemented = SSL_GetImplementedCiphers();
  int implemented_count = SSL_GetNumImplementedCiphers();
  int index;
  SSLVersionRange range = {SSL_LIBRARY_VERSION_TLS_1_2,
                           SSL_LIBRARY_VERSION_TLS_1_3};
  SSLCertificateCompressionAlgorithm zlib_alg = {
      1, "zlib", NULL, unsupported_cert_decode};
  SSLCertificateCompressionAlgorithm brotli_alg = {
      2, "brotli", NULL, unsupported_cert_decode};
  SSLCertificateCompressionAlgorithm zstd_alg = {
      3, "zstd", NULL, unsupported_cert_decode};

  for (index = 0; index < implemented_count; index++) {
    if (SSL_CipherPrefSet(fd, implemented[index], PR_FALSE) != SECSuccess)
      fail("SSL_CipherPrefSet disable");
  }
  for (index = 0; index < (int)(sizeof(ciphers) / sizeof(ciphers[0])); index++) {
    if (SSL_CipherPrefSet(fd, ciphers[index], PR_TRUE) != SECSuccess)
      fail("SSL_CipherPrefSet enable");
  }
  if (SSL_CipherSuiteOrderSet(fd, ciphers,
                              sizeof(ciphers) / sizeof(ciphers[0])) !=
      SECSuccess)
    fail("SSL_CipherSuiteOrderSet");
  if (SSL_VersionRangeSet(fd, &range) != SECSuccess)
    fail("SSL_VersionRangeSet");
  if (SSL_NamedGroupConfig(fd, groups, sizeof(groups) / sizeof(groups[0])) !=
      SECSuccess)
    fail("SSL_NamedGroupConfig");
  if (SSL_SendAdditionalKeyShares(fd, 2) != SECSuccess)
    fail("SSL_SendAdditionalKeyShares");
  if (SSL_SignatureSchemePrefSet(
          fd, signatures, sizeof(signatures) / sizeof(signatures[0])) !=
      SECSuccess)
    fail("SSL_SignatureSchemePrefSet");
  if (SSL_OptionSet(fd, SSL_ENABLE_SESSION_TICKETS, PR_TRUE) != SECSuccess)
    fail("SSL_ENABLE_SESSION_TICKETS");
  if (SSL_OptionSet(fd, SSL_ENABLE_OCSP_STAPLING, PR_TRUE) != SECSuccess)
    fail("SSL_ENABLE_OCSP_STAPLING");
  if (SSL_OptionSet(fd, SSL_ENABLE_SIGNED_CERT_TIMESTAMPS, PR_TRUE) !=
      SECSuccess)
    fail("SSL_ENABLE_SIGNED_CERT_TIMESTAMPS");
  if (SSL_OptionSet(fd, SSL_ENABLE_DELEGATED_CREDENTIALS, PR_TRUE) !=
      SECSuccess)
    fail("SSL_ENABLE_DELEGATED_CREDENTIALS");
  if (SSL_OptionSet(fd, SSL_ENABLE_TLS13_COMPAT_MODE, PR_TRUE) != SECSuccess)
    fail("SSL_ENABLE_TLS13_COMPAT_MODE");
  if (SSL_EnableTls13GreaseEch(fd, PR_TRUE) != SECSuccess)
    fail("SSL_EnableTls13GreaseEch");
  if (SSL_SetTls13GreaseEchSize(fd, 100) != SECSuccess)
    fail("SSL_SetTls13GreaseEchSize");
  if (SSL_SetCertificateCompressionAlgorithm(fd, zlib_alg) != SECSuccess ||
      SSL_SetCertificateCompressionAlgorithm(fd, brotli_alg) != SECSuccess ||
      SSL_SetCertificateCompressionAlgorithm(fd, zstd_alg) != SECSuccess)
    fail("SSL_SetCertificateCompressionAlgorithm");
}

static int connect_ipv4(const char *host, const char *port) {
  struct addrinfo hints;
  struct addrinfo *addresses = NULL;
  struct addrinfo *item;
  int fd = -1;
  memset(&hints, 0, sizeof(hints));
  /* Keep the resolver's address order. Firefox may select IPv6 or IPv4 based
   * on the current route; forcing AF_INET makes DeviceConfig/f42 diverge. */
  hints.ai_family = AF_UNSPEC;
  hints.ai_socktype = SOCK_STREAM;
  if (getaddrinfo(host, port, &hints, &addresses) != 0) {
    perror("getaddrinfo");
    exit(2);
  }
  for (item = addresses; item; item = item->ai_next) {
    fd = socket(item->ai_family, item->ai_socktype, item->ai_protocol);
    if (fd >= 0 && connect(fd, item->ai_addr, item->ai_addrlen) == 0) break;
    if (fd >= 0) close(fd);
    fd = -1;
  }
  freeaddrinfo(addresses);
  if (fd < 0) {
    perror("connect");
    exit(2);
  }
  struct timeval timeout = {.tv_sec = 20, .tv_usec = 0};
  int one = 1;
  setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  return fd;
}

static void write_all_native(int fd, const unsigned char *data, size_t len) {
  while (len > 0) {
    ssize_t written = send(fd, data, len, 0);
    if (written <= 0) {
      perror("send");
      exit(2);
    }
    data += written;
    len -= (size_t)written;
  }
}

static void establish_http_tunnel(int fd, const char *host, const char *port) {
  static const char ua[] =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:142.0) "
      "Gecko/20100101 Firefox/142.0";
  size_t needed = strlen(host) * 2 + strlen(port) * 2 + strlen(ua) + 160;
  char *request = malloc(needed);
  if (!request) {
    perror("malloc");
    exit(2);
  }
  int request_len = snprintf(
      request, needed,
      "CONNECT %s:%s HTTP/1.1\r\n"
      "User-Agent: %s\r\n"
      "Proxy-Connection: keep-alive\r\n"
      "Connection: keep-alive\r\n"
      "Host: %s:%s\r\n\r\n",
      host, port, ua, host, port);
  if (request_len < 0 || (size_t)request_len >= needed) {
    free(request);
    fprintf(stderr, "CONNECT request overflow\n");
    exit(2);
  }
  write_all_native(fd, (const unsigned char *)request, (size_t)request_len);
  free(request);

  char response[16384];
  size_t used = 0;
  while (used + 1 < sizeof(response)) {
    ssize_t count = recv(fd, response + used, 1, 0);
    if (count <= 0) {
      perror("recv CONNECT");
      exit(2);
    }
    used += (size_t)count;
    response[used] = '\0';
    if (used >= 4 && memcmp(response + used - 4, "\r\n\r\n", 4) == 0)
      break;
  }
  if (used + 1 >= sizeof(response) ||
      (strncmp(response, "HTTP/1.1 200", 12) != 0 &&
       strncmp(response, "HTTP/1.0 200", 12) != 0)) {
    fprintf(stderr, "CONNECT failed: %.*s\n", (int)used, response);
    exit(2);
  }
}

static void write_all_pr(PRFileDesc *fd, const unsigned char *data, size_t len) {
  while (len > 0) {
    PRInt32 written = PR_Write(fd, data, (PRInt32)len);
    if (written <= 0) fail("PR_Write");
    data += written;
    len -= (size_t)written;
  }
}

static void read_all_pr(PRFileDesc *fd, unsigned char *data, size_t len) {
  while (len > 0) {
    PRInt32 received = PR_Read(fd, data, (PRInt32)len);
    if (received <= 0) fail("PR_Read");
    data += received;
    len -= (size_t)received;
  }
}

static void write_all_file(FILE *file, const unsigned char *data, size_t len) {
  if (len > 0 && fwrite(data, 1, len, file) != len) {
    perror("fwrite");
    exit(2);
  }
}

static int read_exact_file(FILE *file, unsigned char *data, size_t len,
                           int allow_eof) {
  size_t used = 0;
  while (used < len) {
    size_t count = fread(data + used, 1, len - used, file);
    if (count == 0) {
      if (allow_eof && used == 0 && feof(file)) return 0;
      if (ferror(file)) perror("fread");
      else fprintf(stderr, "truncated framed input\n");
      exit(2);
    }
    used += count;
  }
  return 1;
}

static void append_bytes(unsigned char **buffer, size_t *used, size_t *capacity,
                         const unsigned char *data, size_t len) {
  if (*used + len > *capacity) {
    size_t next = *capacity ? *capacity : 16384;
    while (next < *used + len) next *= 2;
    unsigned char *grown = realloc(*buffer, next);
    if (!grown) {
      free(*buffer);
      perror("realloc");
      exit(2);
    }
    *buffer = grown;
    *capacity = next;
  }
  memcpy(*buffer + *used, data, len);
  *used += len;
}

static unsigned char *read_stdin(size_t *used) {
  size_t capacity = 16384;
  unsigned char *data = malloc(capacity);
  if (!data) {
    perror("malloc");
    exit(2);
  }
  *used = 0;
  for (;;) {
    if (*used == capacity) {
      capacity *= 2;
      unsigned char *grown = realloc(data, capacity);
      if (!grown) {
        free(data);
        perror("realloc");
        exit(2);
      }
      data = grown;
    }
    size_t count = fread(data + *used, 1, capacity - *used, stdin);
    *used += count;
    if (count == 0) {
      if (ferror(stdin)) {
        free(data);
        perror("fread");
        exit(2);
      }
      return data;
    }
  }
}

static void send_settings_ack(PRFileDesc *fd) {
  static const unsigned char ack[] = {0, 0, 0, 4, 1, 0, 0, 0, 0};
  write_all_pr(fd, ack, sizeof(ack));
}

static size_t h2_frame_size(const unsigned char *data, size_t available) {
  if (available < 9) return 0;
  size_t payload = ((size_t)data[0] << 16) | ((size_t)data[1] << 8) | data[2];
  return payload + 9 <= available ? payload + 9 : 0;
}

static void send_firefox_h2_request(PRFileDesc *fd, const unsigned char *data,
                                    size_t len) {
  static const unsigned char preface[] = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
  size_t offset = sizeof(preface) - 1;
  if (len < offset || memcmp(data, preface, offset) != 0) {
    fprintf(stderr, "invalid HTTP/2 client preface\n");
    exit(2);
  }

  // Firefox's first socket write is preface + SETTINGS + connection
  // WINDOW_UPDATE (70 bytes with the retained profile).
  for (int index = 0; index < 2; index++) {
    size_t frame = h2_frame_size(data + offset, len - offset);
    if (!frame) {
      fprintf(stderr, "truncated initial HTTP/2 frame\n");
      exit(2);
    }
    offset += frame;
  }
  write_all_pr(fd, data, offset);

  // The second write combines HEADERS with the stream WINDOW_UPDATE. Gecko
  // buffers both in Http2StreamBase before flushing the output queue.
  size_t second_start = offset;
  for (int index = 0; index < 2; index++) {
    size_t frame = h2_frame_size(data + offset, len - offset);
    if (!frame) {
      fprintf(stderr, "truncated request HTTP/2 frame\n");
      exit(2);
    }
    offset += frame;
  }
  write_all_pr(fd, data + second_start, offset - second_start);

  // DATA frames are flushed separately. The Init body fits in one frame.
  while (offset < len) {
    size_t frame = h2_frame_size(data + offset, len - offset);
    if (!frame) {
      fprintf(stderr, "truncated DATA frame\n");
      exit(2);
    }
    write_all_pr(fd, data + offset, frame);
    offset += frame;
  }
}

static void proxy_h2(PRFileDesc *fd) {
  size_t request_len = 0;
  unsigned char *request = read_stdin(&request_len);
  if (request_len == 0) {
    free(request);
    fprintf(stderr, "empty HTTP/2 request on stdin\n");
    exit(2);
  }
  send_firefox_h2_request(fd, request, request_len);
  free(request);

  for (;;) {
    unsigned char header[9];
    read_all_pr(fd, header, sizeof(header));
    size_t length = ((size_t)header[0] << 16) | ((size_t)header[1] << 8) |
                    (size_t)header[2];
    if (length > 16777215) {
      fprintf(stderr, "invalid HTTP/2 frame length: %zu\n", length);
      exit(2);
    }
    unsigned char *payload = length ? malloc(length) : NULL;
    if (length && !payload) {
      perror("malloc");
      exit(2);
    }
    if (length) read_all_pr(fd, payload, length);

    write_all_file(stdout, header, sizeof(header));
    write_all_file(stdout, payload, length);
    fflush(stdout);

    unsigned char type = header[3];
    unsigned char flags = header[4];
    unsigned int stream_id = ((unsigned int)(header[5] & 0x7f) << 24) |
                             ((unsigned int)header[6] << 16) |
                             ((unsigned int)header[7] << 8) | header[8];
    if (type == 4 && !(flags & 1)) send_settings_ack(fd);
    if (stream_id == 3 && (flags & 1) && (type == 0 || type == 1)) {
      free(payload);
      return;
    }
    if (type == 7) {
      free(payload);
      fprintf(stderr, "server sent HTTP/2 GOAWAY\n");
      exit(2);
    }
    free(payload);
  }
}

static unsigned int request_stream_id(const unsigned char *data, size_t len) {
  static const unsigned char preface[] = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";
  size_t offset = 0;
  if (len >= sizeof(preface) - 1 &&
      memcmp(data, preface, sizeof(preface) - 1) == 0)
    offset = sizeof(preface) - 1;
  while (offset + 9 <= len) {
    size_t frame = h2_frame_size(data + offset, len - offset);
    if (!frame) break;
    if (data[offset + 3] == 1) {
      return ((unsigned int)(data[offset + 5] & 0x7f) << 24) |
             ((unsigned int)data[offset + 6] << 16) |
             ((unsigned int)data[offset + 7] << 8) | data[offset + 8];
    }
    offset += frame;
  }
  fprintf(stderr, "framed request has no HEADERS stream\n");
  exit(2);
}

static void proxy_h2_session(PRFileDesc *fd) {
  int first = 1;
  for (;;) {
    unsigned char length_bytes[4];
    if (!read_exact_file(stdin, length_bytes, sizeof(length_bytes), 1)) return;
    size_t request_len = ((size_t)length_bytes[0] << 24) |
                         ((size_t)length_bytes[1] << 16) |
                         ((size_t)length_bytes[2] << 8) | length_bytes[3];
    if (request_len == 0 || request_len > 16 * 1024 * 1024) {
      fprintf(stderr, "invalid framed request length: %zu\n", request_len);
      exit(2);
    }
    unsigned char *request = malloc(request_len);
    if (!request) {
      perror("malloc");
      exit(2);
    }
    read_exact_file(stdin, request, request_len, 0);
    unsigned int target_stream = request_stream_id(request, request_len);
    if (first) {
      send_firefox_h2_request(fd, request, request_len);
      first = 0;
    } else {
      write_all_pr(fd, request, request_len);
    }
    free(request);

    unsigned char *response = NULL;
    size_t response_len = 0;
    size_t response_capacity = 0;
    for (;;) {
      unsigned char header[9];
      read_all_pr(fd, header, sizeof(header));
      size_t length = ((size_t)header[0] << 16) | ((size_t)header[1] << 8) |
                      (size_t)header[2];
      unsigned char *payload = length ? malloc(length) : NULL;
      if (length && !payload) {
        perror("malloc");
        exit(2);
      }
      if (length) read_all_pr(fd, payload, length);
      append_bytes(&response, &response_len, &response_capacity, header,
                   sizeof(header));
      append_bytes(&response, &response_len, &response_capacity, payload, length);

      unsigned char type = header[3];
      unsigned char flags = header[4];
      unsigned int stream_id = ((unsigned int)(header[5] & 0x7f) << 24) |
                               ((unsigned int)header[6] << 16) |
                               ((unsigned int)header[7] << 8) | header[8];
      if (type == 4 && !(flags & 1)) send_settings_ack(fd);
      free(payload);
      if (stream_id == target_stream && (flags & 1) &&
          (type == 0 || type == 1))
        break;
      if (type == 7) {
        free(response);
        fprintf(stderr, "server sent HTTP/2 GOAWAY\n");
        exit(2);
      }
    }
    if (response_len > 0xffffffffu) {
      free(response);
      fprintf(stderr, "framed response too large\n");
      exit(2);
    }
    unsigned char output_len[4] = {
        (unsigned char)(response_len >> 24), (unsigned char)(response_len >> 16),
        (unsigned char)(response_len >> 8), (unsigned char)response_len};
    write_all_file(stdout, output_len, sizeof(output_len));
    write_all_file(stdout, response, response_len);
    fflush(stdout);
    free(response);
  }
}

/* HTTP/1.1 stdio mode: one raw request on stdin, response streamed back until
   the peer closes or the connection drains. Used for CDN origins that only
   negotiate http/1.1 ALPN (e.g. we.51job.com since 2026-09-02). */
static void proxy_h1(PRFileDesc *fd) {
  size_t request_len = 0;
  unsigned char *request = read_stdin(&request_len);
  if (request_len == 0) {
    free(request);
    fprintf(stderr, "empty HTTP/1.1 request on stdin\n");
    exit(2);
  }
  write_all_pr(fd, request, request_len);
  free(request);

  size_t response_len = 0;
  size_t response_capacity = 0;
  unsigned char *response = NULL;
  for (;;) {
    unsigned char chunk[16384];
    PRInt32 received = PR_Read(fd, chunk, sizeof(chunk));
    if (received < 0) fail("PR_Read");
    if (received == 0) break;
    append_bytes(&response, &response_len, &response_capacity, chunk,
                 (size_t)received);
  }
  unsigned char output_len[4] = {
      (unsigned char)(response_len >> 24), (unsigned char)(response_len >> 16),
      (unsigned char)(response_len >> 8), (unsigned char)response_len};
  write_all_file(stdout, output_len, sizeof(output_len));
  if (response_len)
    write_all_file(stdout, response, response_len);
  fflush(stdout);
  free(response);
}

static void hold_connection_in_child(PRFileDesc *fd) {
  const char *hold_text = getenv("NSS_HOLD_OPEN_MS");
  if (!hold_text) return;
  long hold_ms = strtol(hold_text, NULL, 10);
  if (hold_ms <= 0 || hold_ms > 120000) return;
  fflush(stdout);
  fflush(stderr);
  pid_t child = fork();
  if (child < 0) fail("fork");
  if (child == 0) {
    close(STDIN_FILENO);
    close(STDOUT_FILENO);
    close(STDERR_FILENO);
    usleep((useconds_t)hold_ms * 1000);
    _exit(0);
  }
  // Let the child retain the tunneled socket without emitting close_notify.
  _exit(0);
}

int main(int argc, char **argv) {
  const char alpn[] = {8, 'h', 't', 't', 'p', '/', '1', '.', '1', 2, 'h', '2'};
  const char *host;
  const char *port;
  int native_fd;
  PRFileDesc *tcp_fd;
  PRFileDesc *ssl_fd;
  SSLNextProtoState alpn_state = SSL_NEXT_PROTO_NO_SUPPORT;
  unsigned char selected[32];
  unsigned int selected_len = 0;

  if (argc < 2) {
    fprintf(stderr, "usage: %s HOST [PORT]\n", argv[0]);
    return 2;
  }
  host = argv[1];
  port = argc > 2 ? argv[2] : "443";

  PR_Init(PR_SYSTEM_THREAD, PR_PRIORITY_NORMAL, 1);
  if (NSS_NoDB_Init(NULL) != SECSuccess) fail("NSS_NoDB_Init");
  if (argc > 5 &&
      (strcmp(argv[3], "--h2-stdio") == 0 ||
       strcmp(argv[3], "--h2-session") == 0 ||
       strcmp(argv[3], "--h1-stdio") == 0)) {
    native_fd = connect_ipv4(argv[4], argv[5]);
    establish_http_tunnel(native_fd, host, port);
  } else {
    native_fd = connect_ipv4(host, port);
  }
  tcp_fd = PR_ImportTCPSocket(native_fd);
  if (!tcp_fd) fail("PR_ImportTCPSocket");
  ssl_fd = SSL_ImportFD(NULL, tcp_fd);
  if (!ssl_fd) fail("SSL_ImportFD");

  if (SSL_OptionSet(ssl_fd, SSL_SECURITY, PR_TRUE) != SECSuccess)
    fail("SSL_SECURITY");
  if (SSL_OptionSet(ssl_fd, SSL_HANDSHAKE_AS_CLIENT, PR_TRUE) != SECSuccess)
    fail("SSL_HANDSHAKE_AS_CLIENT");
  configure_firefox_tls(ssl_fd);
  if (SSL_SetURL(ssl_fd, host) != SECSuccess) fail("SSL_SetURL");
  if (SSL_SetNextProtoNego(ssl_fd, (const unsigned char *)alpn, sizeof(alpn)) !=
      SECSuccess)
    fail("SSL_SetNextProtoNego");
  if (SSL_AuthCertificateHook(ssl_fd, accept_certificate, NULL) != SECSuccess)
    fail("SSL_AuthCertificateHook");
  if (SSL_ResetHandshake(ssl_fd, PR_FALSE) != SECSuccess)
    fail("SSL_ResetHandshake");
  if (SSL_ForceHandshake(ssl_fd) != SECSuccess) fail("SSL_ForceHandshake");

  if (SSL_GetNextProto(ssl_fd, &alpn_state, selected, &selected_len,
                       sizeof(selected)) != SECSuccess)
    fail("SSL_GetNextProto");
  SSLChannelInfo channel = {0};
  channel.length = sizeof(channel);
  if (SSL_GetChannelInfo(ssl_fd, &channel, sizeof(channel)) != SECSuccess)
    fail("SSL_GetChannelInfo");
  fprintf(stderr,
          "NSS handshake ok, ALPN=%.*s state=%d tls=0x%04x cipher=0x%04x "
          "group=%u resumed=%d ech=%d\n",
          (int)selected_len, selected, alpn_state, channel.protocolVersion,
          channel.cipherSuite, channel.keaGroup, channel.resumed,
          channel.echAccepted);
  if (argc > 3 &&
      (strcmp(argv[3], "--h2-stdio") == 0 ||
       strcmp(argv[3], "--h2-session") == 0)) {
    if (selected_len != 2 || memcmp(selected, "h2", 2) != 0) {
      fprintf(stderr, "expected h2 ALPN\n");
      return 2;
    }
    if (strcmp(argv[3], "--h2-session") == 0)
      proxy_h2_session(ssl_fd);
    else {
      proxy_h2(ssl_fd);
      hold_connection_in_child(ssl_fd);
    }
  } else if (argc > 3 && strcmp(argv[3], "--h1-stdio") == 0) {
    proxy_h1(ssl_fd);
  }
  PR_Close(ssl_fd);
  NSS_Shutdown();
  PR_Cleanup();
  return 0;
}
